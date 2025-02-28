import queueJob from "./queue_job.js";
import SenderKeyMessage from "./sender_key_message.js";
import {
  decrypt as decryptMessage,
  encrypt as encryptMessage
} from "libsignal/src/crypto";

export default class GroupCipher {
  constructor(senderKeyStore, senderKeyIdentifier) {
    this.senderKeyStore = senderKeyStore;
    this.senderKeyIdentifier = senderKeyIdentifier;
  }
  queueJob(asyncFunction) {
    return queueJob(this.senderKeyIdentifier.toString(), asyncFunction);
  }
  async encrypt(plaintextWithPadding) {
    return await this.queueJob(async () => {
      const senderKeyRecord = await this.senderKeyStore.loadSenderKey(this.senderKeyIdentifier);
      if (!senderKeyRecord) {
        throw new Error("'SenderKeyRecord' not found for encryption");
      }
      const senderKeyState = senderKeyRecord.getSenderKeyState();
      if (!senderKeyState) {
        throw new Error("No session to encrypt message");
      }
      const iteration = senderKeyState.getSenderChainKey().getIteration();
      const senderKey = this.deriveSenderKey(senderKeyState, iteration === 0 ? 0 : iteration + 1);
      const ciphertext = this.generateCipherText(senderKey.getIv(), senderKey.getCipherKey(), plaintextWithPadding);
      const senderKeyMessage = new SenderKeyMessage(senderKeyState.getKeyId(), senderKey.getIteration(), ciphertext, senderKeyState.getSigningKeyPrivate());
      await this.senderKeyStore.storeSenderKey(this.senderKeyIdentifier, senderKeyRecord);
      return senderKeyMessage.serialize();
    });
  }
  async decrypt(senderKeyMessageBytes) {
    return await this.queueJob(async () => {
      const senderKeyRecord = await this.senderKeyStore.loadSenderKey(this.senderKeyIdentifier);
      if (!senderKeyRecord) {
        throw new Error("'SenderKeyRecord' not found for encryption");
      }
      const senderKeyMessage = new SenderKeyMessage(null, null, null, null, senderKeyMessageBytes);
      const senderKeyState = senderKeyRecord.getSenderKeyState(senderKeyMessage.getKeyId());
      if (!senderKeyState) {
        throw new Error("No session to decrypt message");
      }
      senderKeyMessage.verifySignature(senderKeyState.getSigningKeyPublic());
      const senderKey = this.deriveSenderKey(senderKeyState, senderKeyMessage.getIteration());
      const plaintext = this.extractPlainText(senderKey.getIv(), senderKey.getCipherKey(), senderKeyMessage.getCipherText());
      await this.senderKeyStore.storeSenderKey(this.senderKeyIdentifier, senderKeyRecord);
      return plaintext;
    });
  }
  deriveSenderKey(senderKeyState, iteration) {
    let senderChainKey = senderKeyState.getSenderChainKey();
    if (senderChainKey.getIteration() > iteration) {
      if (senderKeyState.hasSenderMessageKey(iteration)) {
        return senderKeyState.removeSenderMessageKey(iteration);
      }
      throw new Error(`Message received with outdated counter '${senderChainKey.getIteration()}', '${iteration}'`);
    }
    if (iteration - senderChainKey.getIteration() > 2000) {
      throw new Error("Message iteration exceeds limit (2000 messages ahead)");
    }
    while (senderChainKey.getIteration() < iteration) {
      senderKeyState.addSenderMessageKey(senderChainKey.getSenderMessageKey());
      senderChainKey = senderChainKey.getNext();
    }
    senderKeyState.setSenderChainKey(senderChainKey.getNext());
    return senderChainKey.getSenderMessageKey();
  }
  extractPlainText(iv, key, ciphertext) {
    try {
      return decryptMessage(key, ciphertext, iv);
    } catch {
      throw new Error("Invalid message exception");
    }
  }
  generateCipherText(iv, key, plaintext) {
    try {
      iv = typeof iv === "string" ? Buffer.from(iv, "base64") : iv;
      key = typeof key === "string" ? Buffer.from(key, "base64") : key;
      return encryptMessage(key, Buffer.from(plaintext), iv);
    } catch {
      throw new Error("Invalid message exception");
    }
  }
}