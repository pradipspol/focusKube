import type { DocSource } from './ingest.js';

// A curated starting set — the kubernetes.io pages most relevant to debugging live cluster
// resources (what the AI assistant's other tools already surface data for), not full site
// coverage. Add more entries here as gaps show up in practice; ingestSources() is idempotent,
// so re-running after an addition only embeds the new pages' chunks.
export const K8S_DOC_SOURCES: DocSource[] = [
  {
    url: 'https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/',
    title: 'Debug Pods',
    repoPath: 'tasks/debug/debug-application/debug-pods',
  },
  {
    url: 'https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/',
    title: 'Debug Running Pods',
    repoPath: 'tasks/debug/debug-application/debug-running-pod',
  },
  {
    url: 'https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/',
    title: 'Debug Services',
    repoPath: 'tasks/debug/debug-application/debug-service',
  },
  {
    url: 'https://kubernetes.io/docs/tasks/debug/debug-cluster/',
    title: 'Troubleshooting Clusters',
    repoPath: 'tasks/debug/debug-cluster',
  },
  {
    url: 'https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/',
    title: 'Pod Lifecycle',
    repoPath: 'concepts/workloads/pods/pod-lifecycle',
  },
  {
    url: 'https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/',
    title: 'Resource Management for Pods and Containers',
    repoPath: 'concepts/configuration/manage-resources-containers',
  },
  {
    url: 'https://kubernetes.io/docs/tasks/configure-pod-container/assign-cpu-resource/',
    title: 'Assign CPU Resources to Containers and Pods',
    repoPath: 'tasks/configure-pod-container/assign-cpu-resource',
  },
  {
    url: 'https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/',
    title: 'Assign Memory Resources to Containers and Pods',
    repoPath: 'tasks/configure-pod-container/assign-memory-resource',
  },
  {
    url: 'https://kubernetes.io/docs/concepts/workloads/controllers/deployment/',
    title: 'Deployments',
    repoPath: 'concepts/workloads/controllers/deployment',
  },
  {
    url: 'https://kubernetes.io/docs/concepts/services-networking/service/',
    title: 'Service',
    repoPath: 'concepts/services-networking/service',
  },
  {
    url: 'https://kubernetes.io/docs/concepts/storage/persistent-volumes/',
    title: 'Persistent Volumes',
    repoPath: 'concepts/storage/persistent-volumes',
  },
  {
    url: 'https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/',
    title: 'Node-pressure Eviction',
    repoPath: 'concepts/scheduling-eviction/node-pressure-eviction',
  },
];
