export class BinaryInfo {
    protocolVersion = 5;
    sequence = 0;
    events = [];
    buffer = [];
    constructor(options = {}) {
        Object.assign(this, options);
    }
}
