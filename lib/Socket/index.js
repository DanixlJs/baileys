import { DEFAULT_CONNECTION_CONFIG } from "../Defaults/index.js";
import { makeBusinessSocket } from "./business.js";
const makeWASocket = (config) => makeBusinessSocket({
    ...DEFAULT_CONNECTION_CONFIG,
    ...config
});
export default makeWASocket;
