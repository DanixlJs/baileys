import {
    generateKeyPair
} from "libsignal/src/curve";
import {
    randomBytes,
    randomInt
} from "crypto";
export function generateSenderKey() {
    return randomBytes(32);
}
export function generateSenderKeyId() {
    return randomInt(2147483647);
}
export function generateSenderSigningKey(key) {
    if (!key) {
        key = generateKeyPair();
    }
    return {
        public: key.pubKey,
        private: key.privKey,
    };
}