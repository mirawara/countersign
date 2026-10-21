import { describe, expect, it } from "vitest";
import { acquireRepositoryLock, isRepositoryLocked, onRepositoryLockChange } from "../src/shared/repositoryLock";

describe("repository task lock", () => {
  it("reports occupancy changes to the sidebar and releases the lock once", () => {
    const repository = "/tmp/countersign-lock-test";
    const observed: boolean[] = [];
    const unsubscribe = onRepositoryLockChange(() => observed.push(isRepositoryLocked(repository)));
    try {
      const release = acquireRepositoryLock(repository);
      expect(isRepositoryLocked(repository)).toBe(true);
      expect(() => acquireRepositoryLock(repository)).toThrow(/already active/);
      release();
      release();
      expect(isRepositoryLocked(repository)).toBe(false);
      expect(observed).toEqual([true, false]);
    } finally {
      unsubscribe();
    }
  });
});
