/**
 * WebADB - Run ADB commands directly from browser via WebUSB
 * No server required - uses WebUSB API to communicate with Android devices
 * Based on ADB protocol specification
 */

class WebADB {
  constructor() {
    this.device = null;
    this.connected = false;
    this.connection = null;
  }

  async connect() {
    try {
      this.device = await navigator.usb.requestDevice({
        filters: [
          { classCode: 0xFF, subclassCode: 0x42, protocolCode: 0x01 }
        ]
      });

      await this.device.open();
      await this.device.selectConfiguration(1);
      await this.device.claimInterface(0);

      this.connected = true;
      return { success: true, serial: this.device.serialNumber || 'Unknown' };
    } catch (error) {
      this.connected = false;
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

  async send(data, timeout = 5000) {
    if (!this.device) throw new Error('Not connected');

    const endpoint = 0x01;
    const result = await this.device.transferOut(endpoint, data);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
      this.device.transferIn(0x81, 4096).then(inResult => {
        clearTimeout(timer);
        resolve(new Uint8Array(inResult.data.buffer));
      }).catch(reject);
    });
  }

  async shellCommand(command) {
    const encoder = new TextEncoder();
    const cmdBytes = encoder.encode(command);

    const msg = this.createMessage('WRTE', 1, cmdBytes);
    await this.send(msg);

    const response = await this.readResponse();
    return new TextDecoder().decode(response);
  }

  createMessage(command, arg0, data = new Uint8Array(0)) {
    const cmd = this.encodeCommand(command);
    const msg = new Uint8Array(16 + data.length);
    msg.set(cmd, 0);
    msg.set(this.encodeUint32(arg0), 4);
    msg.set(this.encodeUint32(data.length), 8);
    msg.set(this.encodeUint32(this.calculateChecksum(data)), 12);
    msg.set(data, 16);
    return msg;
  }

  encodeCommand(cmd) {
    const bytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) bytes[i] = cmd.charCodeAt(i);
    return bytes;
  }

  encodeUint32(val) {
    const bytes = new Uint8Array(4);
    bytes[0] = val & 0xFF;
    bytes[1] = (val >> 8) & 0xFF;
    bytes[2] = (val >> 16) & 0xFF;
    bytes[3] = (val >> 24) & 0xFF;
    return bytes;
  }

  calculateChecksum(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
    }
    return sum;
  }

  async readResponse() {
    const response = await this.receive();
    if (response.command === 'OKAY') {
      if (response.dataLength > 0) {
        const data = await this.receive();
        return data.data;
      }
      return new Uint8Array(0);
    }
    throw new Error('Command failed: ' + response.command);
  }

  async receive() {
    const data = await this.device.transferIn(0x81, 4096);
    const buffer = new Uint8Array(data.data.buffer);

    const command = String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3]);
    const arg0 = buffer[4] | (buffer[5] << 8) | (buffer[6] << 16) | (buffer[7] << 24);
    const arg1 = buffer[8] | (buffer[9] << 8) | (buffer[10] << 16) | (buffer[11] << 24);
    const dataLength = buffer[12] | (buffer[13] << 8) | (buffer[14] << 16) | (buffer[15] << 24);

    return { command, arg0, arg1, dataLength };
  }
}

window.WebADB = WebADB;
