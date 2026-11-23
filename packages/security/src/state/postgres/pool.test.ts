import { describe, expect, it } from "vitest";
import { createPostgresPool } from "./pool.js";

describe("createPostgresPool", () => {
  it.each([["an empty string", ""], ["undefined", undefined], ["a number", 5]])("refuses %s", (_name, value) => {
    expect(() => createPostgresPool(value as never)).toThrow(TypeError);
  });
  it("builds a lazy pool (no connection yet) with bounded defaults, and an idle-client error cannot crash the process", async () => {
    const pool = createPostgresPool("postgresql://u:p@127.0.0.1:1/db");
    try {
      expect([pool.options.max, pool.options.connectionTimeoutMillis, pool.totalCount]).toEqual([10, 2000, 0]);
      expect(pool.listenerCount("error")).toBeGreaterThan(0);
      expect(() => pool.emit("error", new Error("idle client failed"))).not.toThrow();
    } finally { await pool.end(); }
  });
  it("honours explicit bounds", async () => {
    const pool = createPostgresPool("postgresql://u:p@127.0.0.1:1/db", { max: 3, connectionTimeoutMillis: 500 });
    try { expect([pool.options.max, pool.options.connectionTimeoutMillis]).toEqual([3, 500]); } finally { await pool.end(); }
  });
});

it.each([{max:-1},{max:NaN},{max:1.5},{connectionTimeoutMillis:0},{connectionTimeoutMillis:-1},{connectionTimeoutMillis:Infinity},{connectionTimeoutMillis:2147483648}])("rejects unusable pool bounds %j", options => {
 expect(()=>createPostgresPool("postgresql://u:SECRET@127.0.0.1/db",options)).toThrow(TypeError);
});
it.each(["not a url", "https://u:SECRET@example.com/db", "postgresql://u:SECRET@localhost"])("rejects malformed pool URL without echo %s", value=>{
 expect(()=>createPostgresPool(value)).toThrow(TypeError);
 try{createPostgresPool(value);}catch(error){expect(String(error)).not.toContain("SECRET");}
});
