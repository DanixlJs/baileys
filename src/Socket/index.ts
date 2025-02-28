import { DEFAULT_CONNECTION_CONFIG } from "../Defaults/index.js";
import { UserFacingSocketConfig } from "../Types";
import { makeBusinessSocket } from "./business.js";

const makeWASocket = (config: UserFacingSocketConfig) =>
  makeBusinessSocket({
    ...DEFAULT_CONNECTION_CONFIG,
    ...config
  });

export default makeWASocket;
