# Minikube lab

[Local verification results](verification.md)

Run from the repository root on Ubuntu with Docker, Node.js, [Minikube](https://minikube.sigs.k8s.io/docs/start/) and [kubectl](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/).

```sh
minikube start -p dap-lab --driver=docker
kubectl --context dap-lab wait --for=condition=Ready node/dap-lab --timeout=150s
kubectl --context dap-lab get nodes
docker build -f deploy/docker/Dockerfile -t ai-support-agent-clean:minikube-v1 .
minikube -p dap-lab image load ai-support-agent-clean:minikube-v1
minikube -p dap-lab image ls

k() { kubectl --context dap-lab -n dap-lab "$@"; }
k create namespace dap-lab --dry-run=client -o yaml | k apply -f -
node deploy/k8s/configure.mjs "$(minikube -p dap-lab ip)"
k create configmap dap-postgres-bootstrap \
  --from-file=db/migrations/000_roles.sql --from-file=db/bootstrap/001_passwords.sh \
  --dry-run=client -o yaml | k apply -f -
k apply -f deploy/k8s/postgres.yaml
k rollout status deployment/postgres --timeout=180s
k apply -f deploy/k8s/migrate.yaml
k wait --for=condition=complete job/dap-migrate --timeout=120s
k apply -f deploy/k8s/deployment.yaml
k rollout status deployment/dap-app --timeout=180s
k get pods -l app=dap-app
k apply -f deploy/k8s/service.yaml
k get endpointslices -l kubernetes.io/service-name=dap-app
```

Keep the Git-ignored `.env.k8s.local` while using this lab's PVC. It retains the
passwords used to initialize PostgreSQL. Rerun `configure.mjs` to refresh the
24-hour session, then run `k rollout restart deployment/dap-app` and wait for
the rollout so Pods read the updated Secret. For a revised image, use a new tag
in the build, image load, Deployment and migration Job. Give an updated
migration Job a new name before applying it.

Run `minikube -p dap-lab -n dap-lab service dap-app` to open the service, then
append `/readyz` in the browser. Expect `{"status":"ready"}`. If Minikube
cannot launch a browser, use `--url` and open the printed address. On WSL keep
the tunnel terminal open. Use that base URL in the
[Docker lab guidance request](../../apps/reference-host/README.md#docker-lab)
to check HTTP 200 and `kind: "walkthrough"`.

```sh
k get pods -l app=dap-app -o custom-columns=NAME:.metadata.name,UID:.metadata.uid
pod=$(k get pods -l app=dap-app -o jsonpath='{.items[0].metadata.name}')
k delete pod "$pod"
k get pods -l app=dap-app -w
```

After the replacement Pod is Ready, list the UIDs again and repeat the
`/readyz` request. Expect three Ready app Pods and a new UID. Use
`k describe pod <pod-name>`, `k get events --sort-by=.lastTimestamp`,
`k logs job/dap-migrate`, and `k logs <pod-name> --previous` for diagnosis.
`minikube stop -p dap-lab` stops the lab and retains its data.
