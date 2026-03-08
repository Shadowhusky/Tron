import { describe, it, expect } from "vitest";
import { OfficeState } from "./officeState";
import { CharacterState } from "../types";
import { createDefaultLayout } from "../layout/layoutSerializer";

function tickUntilState(
  state: OfficeState,
  charId: number,
  targetState: CharacterState,
  maxTicks = 2000,
  dt = 0.05,
): boolean {
  for (let i = 0; i < maxTicks; i++) {
    state.update(dt);
    const ch = state.characters.get(charId);
    if (ch && ch.state === targetState) return true;
  }
  return false;
}

describe("OfficeState", () => {
  it("creates layout with seats", () => {
    const state = new OfficeState();
    state.rebuildFromLayout(createDefaultLayout());
    expect(state.seats.length).toBeGreaterThan(0);
    expect(state.layout).not.toBeNull();
  });

  it("adds agent and assigns seat", () => {
    const state = new OfficeState();
    state.rebuildFromLayout(createDefaultLayout());
    state.addAgent(1, "Test Agent");

    const ch = state.characters.get(1);
    expect(ch).toBeDefined();
    expect(ch!.seatId).not.toBeNull();
    expect(ch!.seatCol).toBeDefined();
    expect(ch!.seatRow).toBeDefined();
  });

  it("character starts with matrix spawn effect then goes IDLE", () => {
    const state = new OfficeState();
    state.rebuildFromLayout(createDefaultLayout());
    state.addAgent(1, "Test Agent");

    const ch = state.characters.get(1)!;
    expect(ch.matrixEffect).toBe("spawn");

    // Tick past the matrix effect
    for (let i = 0; i < 20; i++) state.update(0.05);
    expect(ch.matrixEffect).toBeNull();
    expect(ch.state).toBe(CharacterState.IDLE);
  });

  it("setAgentActive sends character to seat and eventually enters TYPE state", () => {
    const state = new OfficeState();
    state.rebuildFromLayout(createDefaultLayout());
    state.addAgent(1, "Test Agent");

    const ch = state.characters.get(1)!;
    // Clear matrix effect first
    ch.matrixEffect = null;

    // Activate agent
    state.setAgentActive(1, true, "execute_command");

    // Character should be walking or already at seat
    expect(ch.isActive).toBe(true);

    if (ch.state === CharacterState.WALK) {
      expect(ch.walkPath.length).toBeGreaterThan(0);
      // Tick until TYPE state
      const reachedType = tickUntilState(state, 1, CharacterState.TYPE);
      expect(reachedType).toBe(true);
    } else {
      // If already at seat position, should be TYPE immediately
      expect(ch.state).toBe(CharacterState.TYPE);
    }
  });

  it("character returns to IDLE when agent stops", () => {
    const state = new OfficeState();
    state.rebuildFromLayout(createDefaultLayout());
    state.addAgent(1, "Test Agent");

    const ch = state.characters.get(1)!;
    ch.matrixEffect = null;

    // Start agent
    state.setAgentActive(1, true);
    tickUntilState(state, 1, CharacterState.TYPE);
    expect(ch.state).toBe(CharacterState.TYPE);

    // Stop agent
    state.setAgentActive(1, false);
    // Next tick should transition to IDLE
    state.update(0.05);
    expect(ch.state).toBe(CharacterState.IDLE);
  });

  it("setAgentActive interrupts wandering walk to go to seat", () => {
    const state = new OfficeState();
    state.rebuildFromLayout(createDefaultLayout());
    state.addAgent(1, "Test Agent");

    const ch = state.characters.get(1)!;
    ch.matrixEffect = null;

    // Force character into wander walk state
    ch.state = CharacterState.WALK;
    ch.walkPath = [{ col: 8, row: 8 }]; // Walking to random location
    ch.moveProgress = 0;

    // Activate agent — should interrupt wander and reroute to seat
    state.setAgentActive(1, true, "write_file");

    // Walk path should now lead to seat, not to (8,8)
    const lastWaypoint = ch.walkPath[ch.walkPath.length - 1];
    expect(lastWaypoint).toBeDefined();
    expect(lastWaypoint.col).toBe(ch.seatCol);
    expect(lastWaypoint.row).toBe(ch.seatRow);

    // Should eventually reach TYPE
    const reachedType = tickUntilState(state, 1, CharacterState.TYPE);
    expect(reachedType).toBe(true);
  });

  it("layout rebuild routes active characters to seats", () => {
    const state = new OfficeState();
    // Add agent BEFORE layout
    state.addAgent(1, "Test Agent");
    const ch = state.characters.get(1)!;
    ch.matrixEffect = null;
    ch.isActive = true;

    // Now build layout — should assign seat and route
    state.rebuildFromLayout(createDefaultLayout());

    expect(ch.seatId).not.toBeNull();
    // Should be walking to seat or already there
    expect([CharacterState.WALK, CharacterState.TYPE]).toContain(ch.state);

    // Tick to reach seat
    const reachedType = tickUntilState(state, 1, CharacterState.TYPE);
    expect(reachedType).toBe(true);
  });

  it("multiple agents get different seats", () => {
    const state = new OfficeState();
    state.rebuildFromLayout(createDefaultLayout());
    state.addAgent(1, "Agent 1");
    state.addAgent(2, "Agent 2");
    state.addAgent(3, "Agent 3");

    const ch1 = state.characters.get(1)!;
    const ch2 = state.characters.get(2)!;
    const ch3 = state.characters.get(3)!;

    expect(ch1.seatId).not.toBeNull();
    expect(ch2.seatId).not.toBeNull();
    expect(ch3.seatId).not.toBeNull();
    expect(ch1.seatId).not.toBe(ch2.seatId);
    expect(ch2.seatId).not.toBe(ch3.seatId);
  });
});
