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

// BTHome v2 type constants
let uint8 = 0;
let int8 = 1;
let uint16 = 2;
let int16 = 3;
let uint24 = 4;
let int24 = 5;

// BTHome v2 object descriptors: id → { n: name, t: type, f: factor, u: unit }
let BTH = {};
BTH[0x00] = { n: "pid", t: uint8 };
BTH[0x01] = { n: "battery", t: uint8, u: "%" };
BTH[0x02] = { n: "temperature", t: int16, f: 0.01, u: "C" };
BTH[0x03] = { n: "humidity", t: uint16, f: 0.01, u: "%" };
BTH[0x04] = { n: "pressure", t: uint24, f: 0.01, u: "hPa" };
BTH[0x05] = { n: "illuminance", t: uint24, f: 0.01, u: "lux" };
BTH[0x09] = { n: "count", t: uint8 };
BTH[0x0A] = { n: "energy", t: uint8 };
BTH[0x0C] = { n: "voltage", t: uint16, f: 0.001, u: "V" };
BTH[0x10] = { n: "power", t: uint8 };
BTH[0x11] = { n: "opening", t: uint8 };
BTH[0x14] = { n: "moisture", t: uint16 };
BTH[0x15] = { n: "batteryLow", t: uint8 };
BTH[0x16] = { n: "batteryCharging", t: uint8 };
BTH[0x21] = { n: "motion", t: uint8 };
BTH[0x2D] = { n: "window", t: uint8 };
BTH[0x3A] = { n: "button", t: uint8 };
BTH[0x3F] = { n: "rotation", t: int16, f: 0.1, u: "deg" };

function getByteSize(type) {
  if (type === uint8 || type === int8) return 1;
  if (type === uint16 || type === int16) return 2;
  if (type === uint24 || type === int24) return 3;
  return 255;
}

// BTHome v2 decoder
let BTHomeDecoder = {
  // unsigned to signed integer conversion
  utoi: function(num, bitsz) {
    var mask = 1 << (bitsz - 1);
    return num & mask ? num - (1 << bitsz) : num;
  },

  getUInt8: function(buffer) {
    return buffer.at(0);
  },

  getInt8: function(buffer) {
    return this.utoi(this.getUInt8(buffer), 8);
  },

  getUInt16LE: function(buffer) {
    return 0xffff & ((buffer.at(1) << 8) | buffer.at(0));
  },

  getInt16LE: function(buffer) {
    return this.utoi(this.getUInt16LE(buffer), 16);
  },

  getUInt24LE: function(buffer) {
    return 0x00ffffff & ((buffer.at(2) << 16) | (buffer.at(1) << 8) | buffer.at(0));
  },

  getInt24LE: function(buffer) {
    return this.utoi(this.getUInt24LE(buffer), 24);
  },

  getBufValue: function(type, buffer) {
    if (buffer.length < getByteSize(type)) return null;
    if (type === uint8) return this.getUInt8(buffer);
    if (type === int8) return this.getInt8(buffer);
    if (type === uint16) return this.getUInt16LE(buffer);
    if (type === int16) return this.getInt16LE(buffer);
    if (type === uint24) return this.getUInt24LE(buffer);
    if (type === int24) return this.getInt24LE(buffer);
    return null;
  },

  unpack: function(buffer) {
    if (typeof buffer !== "string" || buffer.length === 0) return null;

    var result = {};
    var dib = buffer.at(0);
    result.encryption = (dib & 0x1) ? true : false;
    result.BTHome_version = dib >> 5;

    if (result.BTHome_version !== 2) return null;
    if (result.encryption) return result;

    buffer = buffer.slice(1);

    while (buffer.length > 0) {
      var objId = buffer.at(0);
      var bth = BTH[objId];

      if (typeof bth === "undefined") {
        print("Unknown BTHome object ID: 0x" + objId.toString(16));
        break;
      }

      buffer = buffer.slice(1);
      var value = this.getBufValue(bth.t, buffer);
      if (value === null) break;

      if (typeof bth.f !== "undefined") {
        value = value * bth.f;
      }
      result[bth.n] = value;

      buffer = buffer.slice(getByteSize(bth.t));
    }

    return result;
  }
};

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

  let parsed = BTHomeDecoder.unpack(result.service_data.fcd2);
  if (!parsed) return;
  if (parsed.encryption) return;

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