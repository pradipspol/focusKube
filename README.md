# K8 Explorer

K8 Explorer is an open-source Kubernetes Desktop operations tool that combines a web UI, a Node.js backend, and a cross-platform (Windows, macOS, Linux) desktop shell into one workspace. It is designed for browsing cluster state, inspecting workloads, managing Helm releases, and working with Azure and AWS-backed Kubernetes contexts from a single interface.

## Features

- Browse Kubernetes resources, workloads, and namespaces.
- Inspect and manage Helm charts and releases.
- Connect to Azure AKS and AWS EKS environments.
- View logs, port-forward workloads, and open exec terminals from the UI.
- Track observability data such as timelines, correlated events, and state snapshots.
- Run as a desktop app for a tighter local workflow on Windows, macOS, or Linux.

## Prerequisites

- Access to an Azure AKS or AWS EKS cluster.
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) for Azure authentication.
- [Helm](https://helm.sh/docs/intro/install/) for Helm operations.

The desktop app installs both of these automatically on first run if they're missing, so manual setup is optional.

## Install the Desktop App

Download the latest installer for your platform from the [Releases page](https://github.com/pradipspol/k8-explorer/releases), then:

### Windows
1. Run `k8-explorer-Setup-<version>.exe` or the `.msi`.
2. Launch K8 Explorer from the Start Menu.

### macOS
1. Open the `.dmg` and drag **K8 Explorer** into **Applications** (or unzip the `.zip` and move the `.app` there yourself).
2. The app isn't code-signed yet, so Gatekeeper will block the first launch. Right-click (or Control-click) the app in Finder and choose **Open**, then confirm in the dialog — you only need to do this once.

### Linux
- **AppImage**: `chmod +x k8-explorer-Setup-<version>.AppImage && ./k8-explorer-Setup-<version>.AppImage`
- **Debian/Ubuntu**: `sudo dpkg -i k8-explorer-Setup-<version>.deb` (or `sudo apt install ./k8-explorer-Setup-<version>.deb` to also resolve missing dependencies)

### After installing (any platform)
Sign in to Azure or AWS to connect to your AKS or EKS environments.

## Development

For development, refer to [DEVELOPMENT.md](DEVELOPMENT.md).

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.
