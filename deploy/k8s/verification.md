# Minikube lab verification

Verified locally on 2026-11-23 using Minikube v1.39.0 with the Docker driver,
Kubernetes v1.37.0, and kubectl v1.37.2. The profile and namespace were both
`dap-lab`.

| Check | Observed result |
| --- | --- |
| `kubectl get nodes` | `dap-lab` was `Ready` |
| `minikube image ls` | `ai-support-agent-clean:minikube-v1` was present |
| `kubectl get jobs` | `dap-migrate` completed `1/1` |
| `kubectl get pods -l app=dap-app` | Three Pods were `1/1 Running` |
| `kubectl get svc` and `kubectl get endpointslices` | NodePort `8787:30878/TCP` with three Pod endpoints |
| `minikube service dap-app --url` | Chrome loaded `/readyz` from the Service tunnel and displayed `{"status":"ready"}` |
| `POST /api/guidance` through the Service | HTTP 200 with `kind: "walkthrough"` |

## Self-healing

| Pod | UID |
| --- | --- |
| Deleted `dap-app-5d86945545-7t942` | `5369f292-2a95-4483-b286-ac3795a30ba0` |
| Replacement `dap-app-5d86945545-nlzlf` | `8a5d8812-9d39-4390-9489-f75ffeafc8b7` |

The other two Pod UIDs stayed the same. The Deployment returned to
three Ready Pods, the Service listed three endpoints again, and
`GET /readyz` returned HTTP 200 after the replacement.
