import { proto } from "../../WAProto/index.js";
import { BinaryNode } from "./types";
export declare const getBinaryNodeChildren: (node: BinaryNode | undefined, childTag: string) => BinaryNode[];
export declare const getAllBinaryNodeChildren: ({ content }: BinaryNode) => BinaryNode[];
export declare const getBinaryNodeChild: (node: BinaryNode | undefined, childTag: string) => BinaryNode;
export declare const getBinaryNodeChildBuffer: (node: BinaryNode | undefined, childTag: string) => Uint8Array | Buffer;
export declare const getBinaryNodeChildString: (node: BinaryNode | undefined, childTag: string) => string;
export declare const getBinaryNodeChildUInt: (node: BinaryNode, childTag: string, length: number) => number;
export declare const assertNodeErrorFree: (node: BinaryNode) => void;
export declare const reduceBinaryNodeToDictionary: (node: BinaryNode, tag: string) => {
    [_: string]: string;
};
export declare const getBinaryNodeMessages: ({ content }: BinaryNode) => proto.WebMessageInfo[];
export declare function binaryNodeToString(node: BinaryNode | BinaryNode["content"], i?: number): any;
