let CONFIG = {
  // the BTHome motion and light sensors that will report to this device
  // add a Bluetooth MAC address for each reporting sensor
  sensorMACs: [
    "3c:2e:f5:ba:e8:bd".toLowerCase()   // Shelly BLU Motion sensor
  ],
  lightId: 0,                           // Channel 0 in Lights x4 mode
  fullBrightness: 100,                  // max when very bright ambient
  minBrightness: 5,                     // min when very dark (soft night light)
  timeoutSec: 300,                      // shared timeout for motion
  defaultLux: 35,                       // fallback if no recent lux readings

  // Brightness factor: higher lux → higher LED brightness (to compete with daylight)
  // Adjust thresholds based on your scene's actual lux requirements
  luxToFactor: function(lux) {
    if (lux < 10)   return 0.10;        // very dark → soft glow
    if (lux < 50)   return 0.20;
    if (lux < 150)  return 0.40;        // typical evening indoor
    if (lux < 400)  return 0.60;
    if (lux < 800)  return 0.80;
    return 1.00;                        // bright/daylight → full power
  }
};

// persistent globals
let motionActive = false;
let luxValues = {};                     // {mac: latest lux}
let timeoutTimer = null;
let lastPacketIds = {};                 // debounce per sensor using pid

// helper: get the current average lux
function getAverageLux() {
  let sum = 0;
  let count = 0;
  for (let mac in luxValues) {
    if (typeof luxValues[mac] === "number") {
      sum += luxValues[mac];
      count++;
    }
  }
  return count > 0 ? sum / count : CONFIG.defaultLux;
}

// BTHome v2 object sizes (bytes) - needed to skip unknown objects
let BTHOME_SIZES = {
  0x00: 1,  // Packet ID (uint8)
  0x01: 1,  // Battery (uint8, %)
  0x02: 2,  // Temperature (sint16, 0.01°C)
  0x03: 2,  // Humidity (uint16, 0.01%)
  0x04: 3,  // Pressure (uint24, 0.01 hPa)
  0x05: 3,  // Illuminance (uint24, 0.01 lux)
  0x09: 1,  // Count (uint8)
  0x0A: 1,  // Energy (uint8)
  0x0C: 2,  // Voltage (uint16, 0.001V)
  0x10: 1,  // Power (bool)
  0x11: 1,  // Opening (bool)
  0x14: 2,  // Moisture (uint16)
  0x15: 1,  // Battery (bool, low)
  0x16: 1,  // Battery charging (bool)
  0x21: 1,  // Motion (uint8)
  0x2D: 1,  // Window (bool)
  0x3A: 1,  // Button (uint8, event)
  0x3F: 2,  // Rotation (sint16, 0.1°)
  0x45: 1   // Text (length prefix - special)
};

// helper: parse BTHome v2 payload (string of bytes)
function parseBTHome(dataStr) {
  if (!dataStr || dataStr.length < 1) return null;

  let bytes = [];
  for (let i = 0; i < dataStr.length; i++) {
    bytes.push(dataStr.charCodeAt(i));
  }

  let offset = 0;

  // check if data starts with UUID bytes (0xD2, 0xFC)
  // some Shelly APIs include them, some don't
  if (bytes.length >= 2 && bytes[0] === 0xD2 && bytes[1] === 0xFC) {
    offset = 2;  // Skip UUID bytes
  }

  if (offset >= bytes.length) return null;

  let devInfo = bytes[offset++];
  let version = (devInfo >> 5) & 0x07;
  if (version !== 2) return null;

  let result = {};

  while (offset < bytes.length) {
    let id = bytes[offset++];
    let size = BTHOME_SIZES[id];

    // unknown object ID - cannot continue parsing safely
    if (typeof size === "undefined") {
      print("Unknown BTHome object ID: 0x" + id.toString(16));
      break;
    }

    // check bounds before reading
    if (offset + size > bytes.length) break;

    switch (id) {
      case 0x00: // Packet ID: uint8
        result.pid = bytes[offset];
        break;

      case 0x01: // Battery: uint8 (%)
        result.battery = bytes[offset];
        break;

      case 0x05: // Illuminance: uint24 LE * 0.01 → lux
        result.illuminance = (bytes[offset] | (bytes[offset+1] << 8) | (bytes[offset+2] << 16)) * 0.01;
        break;

      case 0x21: // Motion: uint8 (0 = no motion, 1 = motion)
        result.motion = bytes[offset];
        break;

      case 0x3A: // Button: uint8 (event type)
        result.button = bytes[offset];
        break;

      // Other known objects - just skip (size is known)
    }
    offset += size;
  }

  return result;
}

// publish sensor data to MQTT if configured
function publishToMQTT(addr, rssi, parsed) {
  let sysStatus = Shelly.getComponentStatus("sys");
  let timestamp = sysStatus ? sysStatus.unixtime : null;
  let topic = "bthome/" + addr.split(":").join("");
  let payload = JSON.stringify({
    mac: addr,
    rssi: rssi,
    motion: parsed.motion,
    illuminance: parsed.illuminance,
    battery: parsed.battery,
    pid: parsed.pid,
    timestamp: timestamp
  });
  //print("MQTT payload " + payload)
  MQTT.publish(topic, payload);
}

// BLE scan event handler
function onBLEScan(event, result) {
  if (event !== BLE.Scanner.SCAN_RESULT) return;

  let addr = result.addr.toLowerCase();
  if (CONFIG.sensorMACs.indexOf(addr) === -1) return;

  if (!result.service_data || !result.service_data.fcd2) return;

  let parsed = parseBTHome(result.service_data.fcd2);
  if (!parsed) return;

  let pid = parsed.pid || 0;
  if (lastPacketIds[addr] === pid) return;  // debounce duplicates
  lastPacketIds[addr] = pid;

  let logMsg = "From " + addr + ": RSSI " + result.rssi + ", Motion: " + (parsed.motion !== undefined ? parsed.motion : "N/A") + ", Lux: " + (parsed.illuminance !== undefined ? parsed.illuminance.toFixed(1) : "N/A");
  if (parsed.battery !== undefined) {
    logMsg += ", Batt: " + parsed.battery + "%";
  }
  print(logMsg);
  
  publishToMQTT(addr, result.rssi, parsed);

  // update lux for this sensor
  if (typeof parsed.illuminance === "number") {
    luxValues[addr] = parsed.illuminance;
  }

  // motion from either sensor → turn on & reset timeout
  if (parsed.motion === 1) {
    let avgLux = getAverageLux();
    let factor = CONFIG.luxToFactor(avgLux);
    let brightness = Math.max(CONFIG.minBrightness, Math.round(factor * CONFIG.fullBrightness));

    Shelly.call("Light.Set", { id: CONFIG.lightId, on: true, brightness: brightness }, function(res, err) {
      if (err) {
        print("Light.Set ON error: " + JSON.stringify(err));
      }
    });
    print("Motion detected! Avg lux: " + avgLux.toFixed(1) + ", Brightness: " + brightness + "%");

    motionActive = true;

    if (timeoutTimer) Timer.clear(timeoutTimer);
    timeoutTimer = Timer.set(CONFIG.timeoutSec * 1000, false, function() {
      Shelly.call("Light.Set", { id: CONFIG.lightId, on: false }, function(res, err) {
        if (err) {
          print("Light.Set OFF error: " + JSON.stringify(err));
        }
      });
      motionActive = false;
      print("No motion for " + CONFIG.timeoutSec + "s - lights OFF");
    });
  }
}

// initialize BLE scanning
function initBLE() {
  BLE.Scanner.Subscribe(onBLEScan);

  let scanCfg = {
    duration_ms: BLE.Scanner.INFINITE_SCAN,
    active: false,  // passive scan is sufficient
    filter: {}
  };

  let res = BLE.Scanner.Start(scanCfg);
  if (!res) {
    print("BLE start failed: " + JSON.stringify(res));
  } else {
    print("BLE scanning started for motion and lux sensors: " + JSON.stringify(res));
  }
}

initBLE();