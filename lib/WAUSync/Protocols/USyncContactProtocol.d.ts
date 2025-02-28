import { USyncQueryProtocol } from "../../Types/USync.js";
import { BinaryNode } from "../../WABinary/index.js";
import { USyncUser } from "../USyncUser.js";
export declare class USyncContactProtocol implements USyncQueryProtocol {
    name: string;
    getQueryElement(): BinaryNode;
    getUserElement(user: USyncUser): BinaryNode;
    parser(node: BinaryNode): boolean;
}
