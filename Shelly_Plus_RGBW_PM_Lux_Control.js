let CONFIG = {
  debug: false,
  active: false,                        // passive BLE scanning is sufficient
  // BTHome light sensor(s) that will report to this device
  sensorMACs: [
    "3c:2e:f5:ba:e8:bd"                 // Shelly BLU Motion sensor
  ],
  lightId: 0,                           // Channel 0 in Lights x4 mode
  fullBrightness: 100,                  // max brightness
  minBrightness: 5,                     // min brightness (avoid completely dark)

  // Brightness factor: higher lux → higher LED brightness
  luxToFactor: function(lux) {
    if (lux < 10)   return 0.10;        // very dark → soft glow
    if (lux < 50)   return 0.20;
    if (lux < 150)  return 0.40;        // typical evening indoor
    if (lux < 400)  return 0.60;
    if (lux < 800)  return 0.80;
    return 1.00;                        // bright/daylight → full power
  }
};

let luxValues = {};                     // {mac: latest lux}
let lastPacketIds = {};                 // debounce per sensor using pid
let currentBrightness = -1;             // track to avoid redundant calls
let _processedMacAddresses = null;      // lowercase, deduplicated MACs

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

// debug logger
function logger(message, prefix) {
  if (!CONFIG.debug) return;
  let text = "";
  if (Array.isArray(message)) {
    for (let i = 0; i < message.length; i++) {
      text += " " + JSON.stringify(message[i]);
    }
  } else {
    text = JSON.stringify(message);
  }
  prefix = typeof prefix === "string" ? prefix + ":" : "";
  console.log(prefix, text);
}

// BTHome v2 decoder
let BTHomeDecoder = {
  // unsigned to signed integer conversion
  utoi: function(num, bitsz) {
    let mask = 1 << (bitsz - 1);
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

    let result = {};
    let dib = buffer.at(0);
    result.encryption = (dib & 0x1) ? true : false;
    result.BTHome_version = dib >> 5;

    if (result.BTHome_version !== 2) return null;
    if (result.encryption) {
      logger("Encrypted devices are not supported", "BTH");
      return result;
    }

    buffer = buffer.slice(1);

    while (buffer.length > 0) {
      let objId = buffer.at(0);
      let bth = BTH[objId];

      if (typeof bth === "undefined") {
        logger(["Unknown BTHome object ID:", "0x" + objId.toString(16)], "BTH");
        break;
      }

      buffer = buffer.slice(1);
      let value = this.getBufValue(bth.t, buffer);
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
  return count > 0 ? sum / count : null;
}

// update LED brightness based on current lux
function updateBrightness() {
  let avgLux = getAverageLux();
  if (avgLux === null) return;

  let factor = CONFIG.luxToFactor(avgLux);
  let brightness = Math.max(CONFIG.minBrightness, Math.round(factor * CONFIG.fullBrightness));

  // only update if brightness changed
  if (brightness === currentBrightness) return;

  Shelly.call("Light.Set", { id: CONFIG.lightId, brightness: brightness }, function(res, err) {
    if (err) {
      print("Light.Set error: " + JSON.stringify(err));
    } else {
      currentBrightness = brightness;
      print("Lux: " + avgLux.toFixed(1) + " -> Brightness: " + brightness + "%");
    }
  });
}

// handle received BTHome packet
function onReceivedPacket(data) {
  // filter by allowed MAC addresses
  if (_processedMacAddresses !== null) {
    if (_processedMacAddresses.indexOf(data.address) < 0) {
      logger(["Received event from", data.address, "outside allowed addresses"], "Info");
      return;
    }
  }

  // update lux for this sensor and adjust brightness
  if (typeof data.illuminance === "number") {
    luxValues[data.address] = data.illuminance;
    updateBrightness();
  }
}

// BLE scan callback
function BLEScanCallback(event, result) {
  if (event !== BLE.Scanner.SCAN_RESULT) return;

  if (typeof result.service_data === "undefined" ||
      typeof result.service_data["fcd2"] === "undefined") {
    return;
  }

  let unpackedData = BTHomeDecoder.unpack(result.service_data["fcd2"]);

  if (unpackedData === null || typeof unpackedData === "undefined") {
    return;
  }

  if (unpackedData.encryption) {
    logger("Encrypted devices are not supported", "Error");
    return;
  }

  // debounce by packet ID
  let addr = result.addr.toLowerCase();
  let pid = unpackedData.pid || 0;
  if (lastPacketIds[addr] === pid) return;
  lastPacketIds[addr] = pid;

  unpackedData.rssi = result.rssi;
  unpackedData.address = addr;

  onReceivedPacket(unpackedData);
}

// initialize BLE scanning
function init() {
  // check BLE is enabled
  let BLEConfig = Shelly.getComponentConfig("ble");
  if (!BLEConfig.enable) {
    console.log("Error: Bluetooth is not enabled, please enable it in settings");
    return;
  }

  // process MAC addresses: lowercase and deduplicate
  if (typeof CONFIG.sensorMACs !== "undefined" && CONFIG.sensorMACs !== null) {
    _processedMacAddresses = CONFIG.sensorMACs
      .map(function(mac) { return mac.toLowerCase(); })
      .filter(function(value, index, array) { return array.indexOf(value) === index; });
  }

  // start scanner if not already running
  if (BLE.Scanner.isRunning()) {
    console.log("Info: BLE scanner already running, managed by device");
  } else {
    let scanCfg = {
      duration_ms: BLE.Scanner.INFINITE_SCAN,
      active: CONFIG.active
    };
    let res = BLE.Scanner.Start(scanCfg);
    if (!res) {
      console.log("Error: Cannot start BLE scanner");
      return;
    }
  }

  BLE.Scanner.Subscribe(BLEScanCallback);
  print("BLE scanning started for lux-based brightness control");
}

init();
