# generals-io-bot (High-Performance Competitive Generals.io AI Bot)

An automated, high-performance strategy bot and research framework for [generals.io](https://generals.io).  
This project has undergone **57+ generations of iterative evolution and experimental tuning**, integrating:
- **Hierarchical Rule Engine & Safety Clamps** (Defense, decapitation sniper, opening expansion tempo, anti-bounce city siege protection, gathering trees)
- **Adaptive Dynamic Scouting & Bayesian Inference** (Context-aware scouting switching between bots and human opponents; probabilistic enemy general belief modeling)
- **Imitation Learning Hybrid** (Compact MLP action ranking model trained on elite player subsets to guide mid-game expansion marching)
- **Automated Headless Ladder Cruise System** (Playwright-driven headless Chrome for automated queueing, self-healing reconnection, and live status snapshotting)
- **Frame-Accurate Conformance Simulator & Multi-Dimensional Audit Benchmark Suite** (Offline alignment with official game engine, multi-metric defect audits, and star-bracketed confidence interval win rate evaluations)

---

## 🌟 Core Features & Architecture

### 1. Hierarchical Strategy Engine
Executes single-step decisions every half-turn (~0.5s) based on strict priorities:
1. **Defend & Counter**: Monitors threat radius around the general and enemy main forces; rallies defenses along the lowest-cost paths when under siege.
2. **Sniper / Decapitation**: Calculates required assault forces (`garrison + distance + safety margin`) upon spotting the enemy general; executes an all-in strike when sufficient, or gathers forces along the attack corridor beforehand.
3. **Opening Expansion Tempo**: Prioritizes claiming surrounding neutral land in the first 50 half-turns (aligned with 25-turn economic production cycles); subsequently prioritizes highest-troop tiles to form continuous snake-like expansion lines.
4. **City Siege & Safety Clamp**: Attacks cities only when military power matches or exceeds the strongest opponent and the city is closer to the friendly general; features `CITY_NOBOUNCE` to prevent suicide runs into neutral towers when pathing troops are insufficient.
5. **Marginal Gain Nibble**: Frontline troops take adjacent enemy tiles whenever victory is guaranteed and net troop efficiency is maximized.
6. **Gathering Tree**: Treats dispersed inland troops as leaves and frontline spearheads as roots, consolidating scattered armies along low-cost friendly terrain.

### 2. Adaptive Scouting & Enemy General Belief Modeling
- **Opponent Type Adaptation (v51 Milestone)**:
  - **Against [Bot] Opponents**: Uses scouting projection caps (`projCap`), scanning along the perimeter of enemy territory to prevent over-extension.
  - **Against Human Opponents**: Switches to prior depth directional scanning (aligned with empirical dual-general distance distributions), breaking through human turtling patterns.
- **Spatial Belief Network (`belief.js`)**: Dynamically updates the posterior spatial probability distribution of the enemy general based on fog-of-war terrain, discovered cities, obstacles, and initial contact coordinates.

### 3. Imitation Learning Hybrid
- **Elite Data Distillation**: Experiments demonstrated that indiscriminate corpus expansion diluted distinct playstyles; the model is trained exclusively on **elite human player subsets** filtered from hundreds of replays.
- **Feature Engineering & MLP Ranker**: Extracts 24-dimensional spatial and movement features (see `replays/imitation/FEATURES.md`) to train compact scoring models (`model*.json` / `commit_model.json`).
- **Hybrid Rule + Learning Structure**: Hard survival constraints (decapitation, defense, sieges, opening rhythm) are governed by strict heuristic rules, while routine developmental marching is ranked by the imitation model.

### 4. Automated Headless Ladder Runner (Playwright)
- Driven by Playwright-core with Headless Chrome, `headless_bot.js` provides:
  - Automated 1v1 and FFA ranked matchmaking queueing;
  - Automated match event logging and result persistence (`match_history.log`);
  - Real-time screenshot rendering (`current_status.png`) for remote monitoring.

### 5. Frame-Accurate Simulator & Audit Suite
- **Frame-by-Frame Conformance Testing (`conformance.js`)**: Validates offline simulation against official server packet replays (5100+ frames verified bit-for-bit identical).
- **Realistic Map Generator (`mapgen.js`)**: Parameters strictly calibrated against the empirical distribution of 1804 official matches.
- **Specialized Defect Audits**:
  - Capital defense and fall audits (`cap_audit.js`)
  - City siege and gathering efficiency audits (`city_audit.js`, `city_gather_audit.js`, `city_gate_audit.js`)
  - Idle turn and leak audits (`idle_audit.js`, `leak_audit.js`, `oscil_audit.js`)
  - Stranded troop audits (`stranded_audit.js`)
  - Strike and sniper tests (`strike_audit.js`, `sniper_test.js`)
- **Rigorous Confidence Interval Evaluation (`ver_report.js`, `arena.js`)**:
  - Partitions win rates across opponent star tiers (All, ≥20★, ≥25★, ≥30★) to eliminate rating pool drift;
  - Computes Wilson 95% confidence intervals for generational improvements.

---

## 📁 Repository Structure

```text
├── index.js                     # Official Bot protocol client entrypoint (CLI flags, room config)
├── headless_bot.js              # Playwright headless browser automated ladder runner
├── src/
│   ├── client.js                # Socket.io protocol communication & reconnection layer
│   ├── gamestate.js             # Board state management, fog-of-war memory, map_diff unpacking
│   ├── pathfinding.js           # Binary-heap weighted Dijkstra & multi-source BFS pathfinding
│   ├── belief.js                # Bayesian posterior inference for enemy general localization
│   ├── commit.js                # Action commitment and continuous advance controller
│   ├── strategy.js              # Core strategy dispatch entrypoint (Active: v55)
│   ├── strategy_v1.js ~ v57.js  # Full historical record of 57 generational strategy iterations
│   └── imitation*.js            # Imitation learning inference modules
├── headless-bot-skill/          # Production-grade headless ladder & live streaming suite
│   ├── SKILL.md                 # Agent skill specification (callable as AI Skill)
│   ├── headless_bot.js          # In-browser socket hook, auto-queue, and state dispatcher
│   ├── live_viewer.js           # SSE real-time web spectator dashboard
│   ├── keep_alive.sh            # Process watchdog daemon (auto-restart on crash)
│   ├── restart_bot.sh           # Graceful restart (waits for game completion to avoid forfeit)
│   └── replay_links/            # Match replay archive index and macOS .webloc shortcuts
├── replays/
│   ├── Game.js, Map.js ...      # Official replay unpacking & replay simulation engine (.gior)
│   ├── corpus/                  # Master human battle replay corpus
│   ├── pro/                     # Pro-tier match slices
│   ├── imitation/               # Feature extractors, trainers, and compact model weights
│   └── scorecard.js             # Multi-dimensional performance scorecard
├── test/
│   └── sim.js                   # Offline 5x5 smoke test suite
├── arena.js                     # Offline bot-vs-bot arena
├── conformance.js               # Frame-accurate protocol conformance verifier
├── ver_report.js                # Star-bracketed battle report generator
├── cap_audit.js / city_audit.js # Defect audit script suite
└── current_status.png           # Automated ladder real-time screenshot
```

---

## 🚀 Quick Start

### 1. Environment Setup
Requires Node.js (>= 18.0.0). Install dependencies after cloning:

```bash
npm install
```

### 2. Offline Smoke Test
Run offline sanity checks for patch algorithm, pathfinding, and strategy logic without network:

```bash
node test/sim.js
```

### 3. Private Custom Room Test (Recommended)
Test and debug against bots or friends in a custom room:

```bash
# Set credentials and bot username (Official rule: bot name must start with "[Bot] ")
GENERALS_USER_ID="your_secret_token" GENERALS_USERNAME="[Bot] MyBot" \
  node index.js --mode private --game test_room_123
```
Open the printed room link in your browser to join and battle.

### 4. Ranked Ladder & Production Modes
- **Direct Bot Protocol Connection (Requires approved bot account):**
  ```bash
  # 1v1 Ranked Ladder
  node index.js --mode 1v1

  # FFA Free-For-All
  node index.js --mode ffa
  ```
- **Automated Headless Browser Cruise (Playwright):**
  ```bash
  GENERALS_USER_ID="your_user_id" node headless_bot.js
  ```
  Launches headless Chrome to queue automatically, outputting `current_status.png` and `match_history.log`.

- **Production Headless Cruise + Live Web Spectator Dashboard (Recommended):**
  Navigate to `headless-bot-skill/` with SSE live dashboard and watchdog daemon:
  ```bash
  cd headless-bot-skill

  # 1. Start the real-time web spectator dashboard (Open http://localhost:3000 in browser)
  node live_viewer.js &

  # 2. Start the self-healing automated ladder process
  ./keep_alive.sh

  # 3. Graceful restart (waits for ongoing match to finish, avoiding forfeits)
  ./restart_bot.sh
  ```

### 5. Benchmarks & Audits

- **Generational Bot Arena Duel:**
  ```bash
  node arena.js
  ```
- **Replay Audit & Star-Bracketed Win Rate Report:**
  ```bash
  GIO_ME=your_bot_name node ver_report.js protodump_by_ver/v55
  ```
- **General Defense Fall Audit:**
  ```bash
  node cap_audit.js protodump_ladder
  ```

---

## 📜 License

Released under the [MIT License](LICENSE).
