import { assertNodeErrorFree } from "../../WABinary/index.js";
export class USyncContactProtocol {
    name = "contact";
    getQueryElement() {
        return {
            tag: "contact",
            attrs: {}
        };
    }
    getUserElement(user) {
        //TODO: Implement type / username fields (not yet supported)
        return {
            tag: "contact",
            attrs: {},
            content: user.phone
        };
    }
    parser(node) {
        if (node.tag === "contact") {
            assertNodeErrorFree(node);
            return node?.attrs?.type === "in";
        }
        return false;
    }
}
