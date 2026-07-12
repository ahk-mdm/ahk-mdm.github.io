/**
 * WebADB - Run ADB commands directly from browser via WebUSB
 * Fixed endpoint discovery with debug
 */

class WebADB {
  constructor() {
    this.device = null;
    this.connected = false;
    this.localId = 1;
    this.VERSION = '00200000';
    this.MAX_DATA = 4096;
    this.epOut = null;
    this.epIn = null;
  }

  async connect() {
    try {
      this.device = await navigator.usb.requestDevice({
        filters: []
      });

      await this.device.open();

      // List all configurations and interfaces for debug
      console.log('Configurations:', this.device.configurations.length);
      for (const cfg of this.device.configurations) {
        console.log('  Config', cfg.configurationValue, ':', cfg.interfaces.length, 'interfaces');
        for (const iface of cfg.interfaces) {
          for (const alt of iface.alternates) {
            console.log('    Interface', iface.interfaceNumber, 'class:', alt.interfaceClass.toString(16));
            for (const ep of alt.endpoints) {
              console.log('      EP', ep.endpointNumber, ep.direction, ep.type, ep.packetSize);
            }
          }
        }
      }

      // Select config
      const config = this.device.configurations[0];
      await this.device.selectConfiguration(config.configurationValue);

      // Find first interface with endpoints
      let targetIface = null;
      for (const iface of config.interfaces) {
        for (const alt of iface.alternates) {
          if (alt.endpoints.length >= 2) {
            targetIface = iface;
            break;
          }
        }
        if (targetIface) break;
      }

      if (!targetIface) {
        // Fallback: use first interface
        targetIface = config.interfaces[0];
      }

      const ifaceNum = targetIface.interfaceNumber;
      await this.device.claimInterface(ifaceNum);

      // Get endpoints from claimed interface
      const iface = this.device.configuration.interfaces[ifaceNum];
      const alt = iface.alternate;

      this.epOut = null;
      this.epIn = null;

      for (const ep of alt.endpoints) {
        if (ep.direction === 'out' && ep.type === 'bulk') {
          this.epOut = ep.endpointNumber;
        } else if (ep.direction === 'in' && ep.type === 'bulk') {
          this.epIn = ep.endpointNumber;
        }
      }

      // Fallback: use any endpoints
      if (!this.epOut || !this.epIn) {
        for (const ep of alt.endpoints) {
          if (ep.direction === 'out' && !this.epOut) {
            this.epOut = ep.endpointNumber;
          } else if (ep.direction === 'in' && !this.epIn) {
            this.epIn = ep.endpointNumber;
          }
        }
      }

      console.log('Using EP OUT:', this.epOut, 'EP IN:', this.epIn);

      if (this.epOut === null || this.epIn === null) {
        throw new Error('No suitable endpoints found. Available: ' + alt.endpoints.length);
      }

      // ADB Version exchange
      const cnxn = this.createMessage('CNXN', 0x01000000, this.MAX_DATA, this.VERSION);
      await this.sendMsg(cnxn);
      const resp = await this.recvMsg();

      if (resp.command === 'CNXN') {
        this.connected = true;
        const sysinfo = new TextDecoder().decode(resp.data || new Uint8Array(0));
        const parts = sysinfo.split(';');
        const serial = this.device.serialNumber || parts[0] || 'Unknown';
        return { success: true, serial: serial.trim() };
      }

      return { success: false, error: 'Unexpected response: ' + resp.command };
    } catch (error) {
      this.connected = false;
      try { await this.device?.close(); } catch(e) {}
      return { success: false, error: error.message };
    }
  }

  disconnect() {
    if (this.device) {
      try {
        this.device.releaseInterface(0);
        this.device.close();
      } catch (e) {}
    }
    this.connected = false;
    this.device = null;
  }

  async shellCommand(command) {
    if (!this.connected) throw new Error('Not connected');

    const localId = this.localId++;
    const dest = 'shell:' + command;
    const destBytes = new TextEncoder().encode(dest);
    const openMsg = this.createMessage('OPEN', localId, 0, destBytes);
    await this.sendMsg(openMsg);

    let resp = await this.recvMsg();
    if (resp.command !== 'OKAY') {
      throw new Error('OPEN failed: ' + resp.command);
    }

    let output = '';
    let done = false;

    while (!done) {
      resp = await this.recvMsg();

      if (resp.command === 'WRTE') {
        const text = new TextDecoder().decode(resp.data || new Uint8Array(0));
        output += text;
        const okay = this.createMessage('OKAY', localId, resp.arg0);
        await this.sendMsg(okay);
      } else if (resp.command === 'CLSE') {
        done = true;
        const clse = this.createMessage('CLSE', localId, resp.arg0);
        await this.sendMsg(clse);
      } else if (resp.command === 'OKAY') {
        continue;
      } else {
        done = true;
      }
    }

    return output;
  }

  createMessage(command, arg0, arg1OrData, maybeData) {
    let arg0Val = arg0 || 0;
    let arg1Val = 0;
    let data = new Uint8Array(0);

    if (typeof arg1OrData === 'number') {
      arg1Val = arg1OrData;
      data = maybeData || new Uint8Array(0);
    } else if (arg1OrData instanceof Uint8Array) {
      data = arg1OrData;
    }

    const cmdBytes = new Uint8Array(4);
    for (let i = 0; i < 4 && i < command.length; i++) {
      cmdBytes[i] = command.charCodeAt(i);
    }

    const cs = this.checksum(data);
    const msg = new Uint8Array(24 + data.length);
    msg.set(cmdBytes, 0);
    msg.set(this.u32le(arg0Val), 4);
    msg.set(this.u32le(arg1Val), 8);
    msg.set(this.u32le(data.length), 12);
    msg.set(this.u32le(cs), 16);
    msg.set(this.u32le(cs ^ 0xFFFFFFFF), 20);
    if (data.length > 0) msg.set(data, 24);
    return msg;
  }

  u32le(val) {
    const b = new Uint8Array(4);
    b[0] = val & 0xFF;
    b[1] = (val >> 8) & 0xFF;
    b[2] = (val >> 16) & 0xFF;
    b[3] = (val >> 24) & 0xFF;
    return b;
  }

  checksum(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum >>> 0;
  }

  async sendMsg(msg) {
    await this.device.transferOut(this.epOut, msg);
  }

  async recvMsg() {
    const resp = await this.device.transferIn(this.epIn, this.MAX_DATA + 24);
    const buf = new Uint8Array(resp.data.buffer);

    const command = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
    const arg0 = buf[4] | (buf[5] << 8) | (buf[6] << 16) | (buf[7] << 24);
    const arg1 = buf[8] | (buf[9] << 8) | (buf[10] << 16) | (buf[11] << 24);
    const dataLen = buf[12] | (buf[13] << 8) | (buf[14] << 16) | (buf[15] << 24);

    let data = null;
    if (dataLen > 0 && buf.length > 24) {
      data = buf.slice(24, 24 + dataLen);
    }

    return { command, arg0, arg1, dataLen, data };
  }
}

window.WebADB = WebADB;
