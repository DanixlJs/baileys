import SenderKeyDistributionMessage from "./sender_key_distribution_message.js";
import {
  generateSenderKeyId,
  generateSenderKey,
  generateSenderSigningKey
} from "./keyhelper.js";

export default class GroupSessionBuilder {
  constructor(senderKeyStore) {
    this.senderKeyStore = senderKeyStore;
  }
  async process(senderKeyIdentifier, senderKeyDistributionMessage) {
    const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyIdentifier);
    senderKeyRecord.addSenderKeyState(senderKeyDistributionMessage.getId(), senderKeyDistributionMessage.getIteration(), senderKeyDistributionMessage.getChainKey(), senderKeyDistributionMessage.getSignatureKey());
    await this.senderKeyStore.storeSenderKey(senderKeyIdentifier, senderKeyRecord);
  }
  async create(senderKeyIdentifier) {
    const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyIdentifier);
    if (senderKeyRecord.isEmpty()) {
      const keyId = generateSenderKeyId();
      const senderKey = generateSenderKey();
      const signingKey = generateSenderSigningKey();
      senderKeyRecord.setSenderKeyState(keyId, 0, senderKey, signingKey);
      await this.senderKeyStore.storeSenderKey(senderKeyIdentifier, senderKeyRecord);
    }
    const senderKeyState = senderKeyRecord.getSenderKeyState();
    return new SenderKeyDistributionMessage(senderKeyState.getKeyId(), senderKeyState.getSenderChainKey().getIteration(), senderKeyState.getSenderChainKey().getSeed(), senderKeyState.getSigningKeyPublic());
  }
}