# 🚦 SmartSignal — Digital Logic Traffic Controller

**An interactive 3D simulation comparing traditional fixed-timer traffic signals with digital logic-based adaptive control.**

![Simulation Preview](https://img.shields.io/badge/Status-Project_Complete-brightgreen)
![Tech Stack](https://img.shields.io/badge/Stack-Three.js_|_Vanilla_JS_|_CSS3-blue)

## 🌟 Overview

SmartSignal is a high-fidelity traffic simulation designed to demonstrate the efficiency of **Smart Mode** (Digital Logic Controller) over **Dumb Mode** (Fixed Timer). The simulation features a physically accurate 3D intersection with realistic vehicle kinematics, emergency vehicle overrides, and pedestrian safety logic.

### 🚀 Key Features
- **Dual Mode Exploration**: Switch between "Dumb Mode" (standard 30s cycle) and "Smart Mode" (real-time adaptive logic).
- **Pro Physics**: Vehicles use a path-locked kinematic model with collision avoidance and smooth braking.
- **Digital Logic Visualization**: View the active SR Flip-Flops, Priority Encoders, and Boolean expressions driving the simulation.
- **Live Analytics**: Track "Vehicles Cleared," "Avg Wait Time," and "CO2 Emissions" in a real-time comparison dashboard.
- **Emergency Overrides**: Spawn ambulances and watch the digital logic re-route priority instantly.

## 🛠️ Technology Stack
- **Engine**: Three.js (WebGL)
- **Styling**: Vanilla CSS3 (Glassmorphism & Desktop-First Responsive)
- **Logic**: Pure JavaScript (ES2024 State Machines)
- **Typography**: Inter & JetBrains Mono

## 📖 Technical Breakdown

The project simulates a 4-way intersection using:
- **SR Flip-Flops**: Managing phase states (NS vs EW).
- **Priority Encoders**: Handling the hierarchy of sensor inputs (Emergency > Pedestrian > Density).
- **Kinematic Physics**: Path-based vehicle movement with AABB collision detection.

## 🚦 How to Run Locally

1. Clone or download this project folder.
2. Open `index.html` in your browser.
   * *Note: For best performance, use a local server like Live Server (VS Code extension) or run `npx serve`.*

---

*"Code is craft. Ship with intention."* ⚡
