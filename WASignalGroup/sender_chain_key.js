import SenderMessageKey from "./sender_message_key.js";
import {
  calculateMAC
} from "libsignal/src/crypto.js";
class SenderChainKey {
  MESSAGE_KEY_SEED = Buffer.from([0x01]);
  CHAIN_KEY_SEED = Buffer.from([0x02]);
  iteration = 0;
  chainKey = Buffer.alloc(0);
  constructor(iteration, chainKey) {
    this.iteration = iteration;
    this.chainKey = chainKey;
  }
  getIteration() {
    return this.iteration;
  }
  getSenderMessageKey() {
    return new SenderMessageKey(
      this.iteration,
      this.getDerivative(this.MESSAGE_KEY_SEED, this.chainKey)
    );
  }
  getNext() {
    return new SenderChainKey(
      this.iteration + 1,
      this.getDerivative(this.CHAIN_KEY_SEED, this.chainKey)
    );
  }
  getSeed() {
    return typeof this.chainKey === "string" ? Buffer.from(this.chainKey, "base64") : this.chainKey;
  }
  getDerivative(seed, key) {
    key = typeof key === "string" ? Buffer.from(key, "base64") : key;
    const hash = calculateMAC(key, seed);
    return hash;
  }
}
export default SenderChainKey;