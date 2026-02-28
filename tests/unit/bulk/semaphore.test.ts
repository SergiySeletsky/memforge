export {};

/**
 * Unit tests for lib/memforge/semaphore.ts â€” Spec 06
 *
 * SEM_01 â€” constructor sets correct initial permits
 * SEM_02 â€” acquire/release serializes concurrent work
 * SEM_03 â€” run() executes fn and releases permit automatically
 * SEM_04 â€” run() releases permit even when fn throws
 */

import { Semaphore } from "@/lib/memforge/semaphore";

describe("Semaphore", () => {
  test("SEM_01: constructor(n) allows n concurrent acquisitions without blocking", async () => {
    const sem = new Semaphore(3);
    // Acquiring 3 times should resolve immediately (no await needed)
    const p1 = sem.acquire();
    const p2 = sem.acquire();
    const p3 = sem.acquire();
    await Promise.all([p1, p2, p3]);
    // All resolved without deadlock
    expect(true).toBe(true);
  });

  test("SEM_02: 4th acquire blocks until a permit is released", async () => {
    const sem = new Semaphore(2);
    await sem.acquire(); // permit 1 taken
    await sem.acquire(); // permit 2 taken

    let resolved = false;
    const waitPromise = sem.acquire().then(() => {
      resolved = true;
    });

    // Should not be resolved yet
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Release one permit
    sem.release();

    await waitPromise;
    expect(resolved).toBe(true);
  });

  test("SEM_03: run() executes fn and returns its result", async () => {
    const sem = new Semaphore(1);
    const result = await sem.run(async () => 42);
    expect(result).toBe(42);
  });

  test("SEM_04: run() releases permit even when fn throws", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // Permit should be released â€” next run should succeed immediately
    const result = await sem.run(async () => "ok");
    expect(result).toBe("ok");
  });
});
