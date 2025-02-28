import CiphertextMessage from "./ciphertext_message.js";
import protobufjs from "./protobufs.js";
export default class SenderKeyDistributionMessage extends CiphertextMessage {
  constructor(id = null, iteration = null, chainKey = null, signatureKey = null, serialized = null) {
    super();
    if (serialized) {
      const message = serialized.slice(1);
      const distributionMessage = protobufjs.decode(message).toJSON();
      this.serialized = serialized;
      this.id = distributionMessage.id;
      this.iteration = distributionMessage.iteration;
      this.chainKey = distributionMessage.chainKey;
      this.signatureKey = distributionMessage.signingKey;
    } else {
      const version = this.intsToByteHighAndLow(this.CURRENT_VERSION, this.CURRENT_VERSION);
      this.id = id;
      this.iteration = iteration;
      this.chainKey = chainKey;
      this.signatureKey = signatureKey;
      const message = protobufjs.encode(protobufjs.create({ id, iteration, chainKey, signingKey: this.signatureKey })).finish();
      this.serialized = Buffer.concat([Buffer.from([version]), message]);
    }
  }
  intsToByteHighAndLow(highValue, lowValue) {
    return (((highValue << 4) | lowValue) & 0xff) % 256;
  }
  serialize() {
    return this.serialized;
  }
  getType() {
    return this.SENDERKEY_DISTRIBUTION_TYPE;
  }
  getIteration() {
    return this.iteration;
  }
  getChainKey() {
    return typeof this.chainKey === "string" ? Buffer.from(this.chainKey, "base64") : this.chainKey;
  }
  getSignatureKey() {
    return typeof this.signatureKey === "string" ? Buffer.from(this.signatureKey, "base64") : this.signatureKey;
  }
  getId() {
    return this.id;
  }
}