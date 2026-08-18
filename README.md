# K8 Explorer

K8 Explorer is an open-source Kubernetes Desktop operations tool that combines a web UI, a Node.js backend, and a Windows desktop shell into one workspace. It is designed for browsing cluster state, inspecting workloads, managing Helm releases, and working with Azure and AWS-backed Kubernetes contexts from a single interface.

## Features

- Browse Kubernetes resources, workloads, and namespaces.
- Inspect and manage Helm charts and releases.
- Connect to Azure AKS and AWS EKS environments.
- View logs, port-forward workloads, and open exec terminals from the UI.
- Track observability data such as timelines, correlated events, and state snapshots.
- Run as a desktop app for a tighter local workflow on Windows.

## Prerequisites

- Access to an Azure AKS or AWS EKS cluster.
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) for Azure authentication.
- [Helm](https://helm.sh/docs/intro/install/) for Helm operations.

## Install the Desktop App

1. Download the latest Windows installer from the [Releases page](https://github.com/pradipspol/k8-explorer/releases).
2. Run the installer and launch K8 Explorer.
3. Sign in to Azure or AWS to connect to your AKS or EKS environments.

## Development

For Development, refer [Development.md](DEVELOPMENT)

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.
