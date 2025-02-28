export class USyncUser {
    id;
    lid;
    phone;
    type;
    withId(id) {
        this.id = id;
        return this;
    }
    withLid(lid) {
        this.lid = lid;
        return this;
    }
    withPhone(phone) {
        this.phone = phone;
        return this;
    }
    withType(type) {
        this.type = type;
        return this;
    }
}
