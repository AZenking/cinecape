# SubAgent Orchestration Patterns

This document details common multi-subagent orchestration patterns, their structural topology, and when to apply them.

---

## Pattern 1: Map-Reduce (Fan-Out / Fan-In)

Use this pattern when a task can be divided into $N$ mutually exclusive slices across files, directories, or endpoints.

```mermaid
flowchart TD
    Orchestrator["Primary Orchestrator"]
    Orchestrator -->|Dispatch Task A| SubA["SubAgent 1: Module A (flash)"]
    Orchestrator -->|Dispatch Task B| SubB["SubAgent 2: Module B (flash)"]
    Orchestrator -->|Dispatch Task C| SubC["SubAgent 3: Module C (flash)"]
    SubA -->|Results A| Sync["Collector / Synthesis"]
    SubB -->|Results B| Sync
    SubC -->|Results C| Sync
    Sync --> FinalReport["Consolidated Report / Artifact"]
```

### Ideal Scenarios
- **Large-scale Codebase Audit**: Auditing security, performance, or styling across different sub-packages.
- **Batch Refactoring / Migration**: Migrating deprecated API calls across multiple directories.
- **Bulk Documentation / Unit Testing**: Generating missing unit tests or doc comments across independent classes.

### Best Practices
- **Model Selection**: Usually `Model: 'flash'` or `'flash_lite'` is sufficient and cost-effective.
- **Scope Partitioning**: Give each subagent explicit boundaries (e.g. Subagent 1 only reads `lib/src/auth/`, Subagent 2 only reads `lib/src/network/`).
- **Batch Dispatch**: Send all `invoke_subagent` calls in turn 1, then halt tool execution until reactive notifications arrive.

---

## Pattern 2: The Multi-Role Triad (Implementer + Tester + Auditor)

Use this pattern for feature development, bug fixes, or mission-critical modifications where quality and verification cannot be compromised.

```mermaid
flowchart LR
    Orchestrator["Primary Orchestrator"]
    Orchestrator -->|Task 1: Core Logic| Worker["Implementer Subagent<br/>(Write Tools: true)"]
    Orchestrator -->|Task 2: Test Suite| Tester["Test Engineer Subagent<br/>(Write Tools: true)"]
    Orchestrator -->|Task 3: Edge Case / Sec Audit| Auditor["Code Auditor Subagent<br/>(Write Tools: false)"]

    Worker -.->|Code Changes| Merge["Integrator & Test Runner"]
    Tester -.->|Test Cases| Merge
    Auditor -.->|Audit Findings| Merge
```

### Ideal Scenarios
- Complex feature implementation requiring simultaneous unit test scaffolding.
- Fixing subtle production bugs where regression prevention and security audits are critical.

### Best Practices
- The **Auditor** should have `EnableWriteTools: false` to ensure it only observes and critiques without modifying code.
- The **Implementer** should be constrained to production code (e.g. `src/features/foo/`).
- The **Tester** should be constrained to test directories (e.g. `tests/features/foo_test.ts`).
- Orchestrator runs the test suite once both Implementer and Tester complete.

---

## Pattern 3: Adversarial / Red-Blue Cross-Validation

Use this pattern when deciding on architecture, designing critical schemas, or evaluating trade-offs between competing technical solutions.

```mermaid
flowchart TD
    Orchestrator["Primary Orchestrator"]
    Orchestrator -->|Role: Architect A| Blue["Blue Agent: Solution Alpha<br/>(e.g., SQLite Caching)"]
    Orchestrator -->|Role: Architect B| Red["Red Agent: Solution Beta<br/>(e.g., Redis/Memory Caching)"]
    Blue -->|Proposal & Benchmarks| Eval["Synthesis & Arbiter"]
    Red -->|Proposal & Benchmarks| Eval
    Eval --> Decision["Final Decision & Architecture Artifact"]
```

### Ideal Scenarios
- Complex database schema migration designs.
- Deciding state management libraries or concurrency architectures.
- High-stakes security review where one subagent looks for vulnerabilities (penetration analysis) and another verifies defenses.

### Best Practices
- Use `Model: 'pro'` or `'inherit'` for in-depth reasoning and structural analysis.
- Give each subagent identical business context and performance criteria.

---

## Pattern 4: Staged Pipeline with Stage Concurrence

Use this pattern when tasks have sequential stages, but within each stage, multiple subtasks can run in parallel.

```mermaid
flowchart TD
    subgraph Stage1["Stage 1: Exploration & Schema (Parallel)"]
        A1["Subagent 1: DB Schema Analysis"]
        A2["Subagent 2: API Contract Review"]
    end

    subgraph Stage2["Stage 2: Implementation (Parallel)"]
        B1["Subagent 3: Service Layer (Backend)"]
        B2["Subagent 4: State & UI Layer (Frontend)"]
    end

    subgraph Stage3["Stage 3: Verification (Single Orchestrator)"]
        C1["Run End-to-End Tests & Final Build"]
    end

    Stage1 --> Stage2 --> Stage3
```

### Execution Rules
1. Launch `A1` and `A2` concurrently in a single turn.
2. Wait for Stage 1 subagents to complete and consolidate their contracts.
3. Launch `B1` and `B2` concurrently with the consolidated contracts.
4. In Stage 3, the orchestrator performs the final end-to-end integration test and reports to the user.
