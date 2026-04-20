# GeneRegulatorySystems App

<a href="https://github.com/drostlab/GeneRegulatorySystems-App/releases/latest">
  <img src="https://img.shields.io/github/v/release/drostlab/GeneRegulatorySystems-App?label=latest%20release" alt="Latest release" />
</a>

<p align="center">
  <img src="tauri-app/icons/logogrs.png" width="300" alt="GRS logo" />
</p>

Graphical user interface (GUI) for [GeneRegulatorySystems.jl](https://github.com/drostlab/GeneRegulatorySystems.jl/), a tool for designing complex simulation schedules of stochastic gene regulatory networks. Software documentation is available at <https://drostlab.github.io/GeneRegulatorySystems.jl/>.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshot-light.png">
  <img src="docs/screenshot-light.png" alt="GeneRegulatorySystems App screenshot" />
</picture>

## Installation

Download the latest app binaries from the [Releases page](https://github.com/drostlab/GeneRegulatorySystems-App/releases) for your platform. Once you open it, the app automatically installs all required dependencies (including Julia if needed) and launches. This may take a few minutes on the first launch.

> [!NOTE]
> **macOS users:** The first time you open the app, macOS might show "app is damaged" due to Gatekeeper checks on unsigned apps. To fix this, run this command in the terminal:
>
> ```bash
> xattr -cr "/Applications/Gene Regulatory Systems.app"
> ```
>
> Then you can open the app normally.

## Developer mode

```sh
git clone https://github.com/drostlab/GeneRegulatorySystems-App.git
cd GeneRegulatorySystems-App
./dev.sh
```

This starts the Vue frontend and Julia backend in browser mode. Dependencies are installed automatically on first run. [Node.js](https://nodejs.org/en/download) >= 20, [Julia](https://julialang.org/downloads/) >= 1.11 are required.

For the native desktop window:

```sh
./dev.sh --tauri
```

This requires [Rust](https://rust-lang.org/tools/install/) >= 1.77 to be installed additionally.

### Production build

```sh
cd tauri-app
cargo tauri build
```

Output is written to `tauri-app/target/release/bundle/`. See [tauri-app/README.md](tauri-app/README.md) for details.
