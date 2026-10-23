import { StrictValidation, StrictValidationError } from "../shared/strict";

/**
 * A strict JSON reader for provider responses. JSON.parse silently keeps the last of
 * two duplicate keys, so the protocol cannot use it: a response that declares a field
 * twice is rejected here instead of being read as whichever copy came last.
 */
const MAX_DEPTH = 32;

class JsonError extends Error {
  constructor(readonly detail: StrictValidationError) {
    super(detail.message);
    this.name = "JsonError";
  }
}

export function parseStrictJson(text: string): StrictValidation<unknown> {
  try {
    const reader = new StrictJsonReader(text);
    const value = reader.readValue("$", 0);
    reader.skipWhitespace();
    if (!reader.atEnd()) {
      throw new JsonError({ path: "$", code: "wrong_type", message: "The response has content after the JSON value." });
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof JsonError) return { ok: false, errors: [error.detail] };
    throw error;
  }
}

class StrictJsonReader {
  private index = 0;

  constructor(private readonly text: string) {}

  atEnd(): boolean {
    return this.index >= this.text.length;
  }

  skipWhitespace(): void {
    while (this.index < this.text.length && " \t\n\r".includes(this.text[this.index])) this.index++;
  }

  readValue(path: string, depth: number): unknown {
    if (depth > MAX_DEPTH) this.fail(path, "out_of_range", `The response nests deeper than ${MAX_DEPTH} levels.`);
    this.skipWhitespace();
    const character = this.text[this.index];
    if (character === undefined) this.fail(path, "missing_field", "The response ended before a JSON value.");
    if (character === "{") return this.readObject(path, depth);
    if (character === "[") return this.readArray(path, depth);
    if (character === "\"") return this.readString(path);
    if (character === "-" || (character >= "0" && character <= "9")) return this.readNumber(path);
    if (this.text.startsWith("true", this.index)) return this.take(4, true);
    if (this.text.startsWith("false", this.index)) return this.take(5, false);
    if (this.text.startsWith("null", this.index)) return this.take(4, null);
    return this.fail(path, "wrong_type", `The response is not JSON at character ${this.index}. Free prose is never read as a decision.`);
  }

  private readObject(path: string, depth: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.index++;
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index++;
      return result;
    }
    while (true) {
      this.skipWhitespace();
      if (this.text[this.index] !== "\"") this.fail(path, "wrong_type", "An object key must be a JSON string.");
      const key = this.readString(path);
      if (key === "__proto__") this.fail(`${path}.__proto__`, "unknown_field", "The key __proto__ is not accepted.");
      if (seen.has(key)) this.fail(`${path}.${key}`, "duplicate_key", `The key ${key} appears more than once.`);
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") this.fail(`${path}.${key}`, "wrong_type", "An object key must be followed by ':'.");
      this.index++;
      result[key] = this.readValue(`${path}.${key}`, depth + 1);
      this.skipWhitespace();
      const next = this.text[this.index];
      if (next === ",") {
        this.index++;
        continue;
      }
      if (next === "}") {
        this.index++;
        return result;
      }
      this.fail(path, "wrong_type", "An object member must be followed by ',' or '}'.");
    }
  }

  private readArray(path: string, depth: number): unknown[] {
    const result: unknown[] = [];
    this.index++;
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index++;
      return result;
    }
    while (true) {
      result.push(this.readValue(`${path}[${result.length}]`, depth + 1));
      this.skipWhitespace();
      const next = this.text[this.index];
      if (next === ",") {
        this.index++;
        continue;
      }
      if (next === "]") {
        this.index++;
        return result;
      }
      this.fail(path, "wrong_type", "An array element must be followed by ',' or ']'.");
    }
  }

  private readString(path: string): string {
    this.index++;
    let value = "";
    while (true) {
      const character = this.text[this.index];
      if (character === undefined) this.fail(path, "wrong_type", "The response ended inside a JSON string.");
      if (character === "\"") {
        this.index++;
        return value;
      }
      if (character === "\\") {
        this.index++;
        value += this.readEscape(path);
        continue;
      }
      if (character < " ") this.fail(path, "wrong_type", "A JSON string cannot contain a raw control character.");
      value += character;
      this.index++;
    }
  }

  private readEscape(path: string): string {
    const character = this.text[this.index];
    this.index++;
    switch (character) {
      case "\"": return "\"";
      case "\\": return "\\";
      case "/": return "/";
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "u": {
        const digits = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail(path, "wrong_type", "A \\u escape needs four hexadecimal digits.");
        this.index += 4;
        return String.fromCharCode(Number.parseInt(digits, 16));
      }
      default:
        return this.fail(path, "wrong_type", `Unsupported escape \\${character ?? ""} in a JSON string.`);
    }
  }

  private readNumber(path: string): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.index));
    if (!match) return this.fail(path, "wrong_type", "The response contains a malformed number.");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail(path, "out_of_range", "The response contains a number that is not finite.");
    return value;
  }

  private take<T>(length: number, value: T): T {
    this.index += length;
    return value;
  }

  private fail(path: string, code: StrictValidationError["code"], message: string): never {
    throw new JsonError({ path, code, message });
  }
}
