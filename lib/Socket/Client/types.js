import { EventEmitter } from "events";
export class AbstractSocketClient extends EventEmitter {
    url;
    config;
    constructor(url, config) {
        super();
        this.url = url;
        this.config = config;
        this.setMaxListeners(0);
    }
}
