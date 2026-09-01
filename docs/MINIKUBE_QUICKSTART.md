# Minikube Feature - Quick Start Guide

## Installation & Setup

### Prerequisites
- Node.js 18+
- Docker or Hyper-V (for Minikube)
- Minikube installed locally

### Install Minikube

**macOS:**
```bash
brew install minikube
```

**Windows (Chocolatey):**
```bash
choco install minikube
```

**Windows (Direct Download):**
Download from https://minikube.sigs.k8s.io/docs/start/

**Linux:**
```bash
curl -LO https://github.com/kubernetes/minikube/releases/latest/download/minikube-linux-amd64
sudo install minikube-linux-amd64 /usr/local/bin/minikube
```

## Running FocusKube with Minikube Feature

### Start Development Server

**Backend:**
```bash
cd platform/backend
npm install
npm run dev
```

**Frontend:**
```bash
cd platform/frontend
npm install
npm run dev
```

### Access the Minikube Panel

1. Open FocusKube in your browser
2. Look for "Minikube Local Cluster" section in left sidebar
3. Click "Health" button to verify Minikube is installed

## Common Tasks

### Create a Local Cluster

1. Click **Start** button
2. Configure if needed:
   - Driver: docker (default) or hyperv
   - CPUs: 4 (default)
   - Memory: 4096m (default)
3. Click **Start** button
4. Wait for cluster to initialize (usually 2-3 minutes)

### Deploy a Sample Application

1. Click **New** button in "Deploy Manifest" section
2. Paste this example manifest:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-demo
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:latest
        ports:
        - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: nginx-demo
  namespace: default
spec:
  selector:
    app: nginx
  type: LoadBalancer
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
```

3. Click **Deploy**
4. Check "Deployments" and "Pods" sections to see results

### View Pod Logs

1. Locate your pod in the "Pods" section
2. Click on pod name to expand logs
3. View last 100 lines of logs

### Test Pod Connectivity

1. In "Pods" section, click **Test** button for a pod
2. System checks:
   - Pod is running
   - Pod is ready
   - Retrieves pod status and logs

### Switch Namespaces

1. Use "Namespace" dropdown to select different namespace
2. Pods and deployments list will update automatically
3. Default namespace is "default"

## Testing

### Run Tests

```bash
# Backend tests
cd platform/backend
npm test

# With coverage
npm run test:coverage
```

### Manual API Testing

Use curl or Postman to test endpoints:

```bash
# Check Minikube health
curl http://localhost:3000/api/minikube/health

# Get cluster status
curl http://localhost:3000/api/minikube/status

# Start cluster
curl -X POST http://localhost:3000/api/minikube/start \
  -H "Content-Type: application/json" \
  -d '{"driver": "docker"}'

# List pods
curl "http://localhost:3000/api/minikube/pods?namespace=default"
```

## Troubleshooting

### "Minikube Not Installed"
- Verify installation: `minikube version`
- Add to PATH if not found
- Restart terminal/IDE

### Cluster Start Fails
- Check Docker is running: `docker ps`
- Check available disk space
- Try different driver: hyperv or virtualbox
- View logs: `minikube logs`

### Pods Not Starting
- Check cluster is running: `minikube status`
- Check namespace exists
- View pod logs: Click pod name in UI
- Check resources: `minikube dashboard`

### Can't Access Minikube Panel
- Verify backend is running on port 3000
- Check browser console for errors
- Verify React Query is installed

## Development Workflow

### Adding New Minikube Features

1. **Backend Service** (`minikubeService.ts`):
   ```typescript
   async myNewFeature(param: string): Promise<Result> {
     try {
       // implementation
     } catch (err) {
       logError(`Failed: ${(err as Error).message}`);
       throw internalServerError('Error message');
     }
   }
   ```

2. **API Route** (`minikube.ts`):
   ```typescript
   minikubeRouter.get('/my-feature', withRouteErrorLogging(async (req, res) => {
     const result = await minikubeService.myNewFeature();
     res.json(result);
   }));
   ```

3. **React Hook** (`minikubeApi.ts`):
   ```typescript
   export const useMyFeature = () => {
     return useQuery({
       queryKey: ['minikube', 'my-feature'],
       queryFn: () => fetch('/api/minikube/my-feature').then(r => r.json()),
     });
   };
   ```

4. **UI Component** (`MinikubePanel.tsx`):
   ```typescript
   const { data } = useMyFeature();
   return <div>{data?.result}</div>;
   ```

## Performance Tips

1. **Cluster Resource Allocation**
   - Allocate enough CPUs/Memory based on workload
   - Start small and scale up
   - Monitor with `minikube dashboard`

2. **Network Performance**
   - Use Docker driver (fastest on Linux/Mac)
   - Hyper-V faster on Windows
   - Avoid nested virtualization

3. **Data Refresh Rates**
   - Pod list refreshes every 15 seconds
   - Adjust in `minikubeApi.ts` if needed
   - Higher refresh = more API calls

## Next Steps

- Explore the Minikube dashboard: `minikube dashboard`
- Set up persistent volumes for testing
- Create sample deployment YAML files
- Integrate with CI/CD pipelines
- Use for local development and testing

## Additional Resources

- [Minikube Documentation](https://minikube.sigs.k8s.io/)
- [Kubernetes Documentation](https://kubernetes.io/docs/)
- [FocusKube GitHub](https://github.com/focus-kube/focus-kube)
- [Docker Documentation](https://docs.docker.com/)

## Support

For issues:
1. Check logs in browser console
2. Check backend logs in terminal
3. Review test output: `npm test`
4. Check Minikube status: `minikube status`
5. Review documentation in `/docs/MINIKUBE_FEATURE.md`
