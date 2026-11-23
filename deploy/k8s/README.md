# Minikube лабораторийн тайлан

## Зорилго ба гүйцэтгэл

`ai-support-agent-clean` төслийн backend-ийг локал Kubernetes cluster дээр байршуулсан. Deployment болон Service YAML-ийг бичиж, гурван backend Pod ажиллуулсан. Service-ээр браузераас холбогдож, нэг Pod устахад Kubernetes автоматаар нөхөж үүсгэдгийг шалгасан.

Лабораторийг 2026-11-23-нд Ubuntu/WSL дээр Minikube `v1.39.0`, Docker driver, Kubernetes `v1.37.0`, kubectl `v1.37.2` ашиглан гүйцэтгэсэн. Minikube profile болон Kubernetes namespace хоёулаа `dap-lab` нэртэй.

## Хийсэн ажил ба ажиллах зарчим

| Бүрэлдэхүүн | Үүрэг |
| --- | --- |
| Minikube | Компьютер дээр локал cluster асаана. Энэ cluster нэг Node-той. |
| Deployment | Ижил Docker image-ээс backend-ийн гурван хувийг Pod болгон ажиллуулна. Pod устахад оронд нь шинэ Pod үүсгэнэ. [deployment.yaml](deployment.yaml) |
| Service | Браузераас ирсэн хүсэлтийг бэлэн Pod-уудын аль нэг рүү дамжуулна. `NodePort` нь Node-ийн `30878` портоос backend-ийн `8787` порт руу чиглүүлнэ. [service.yaml](service.yaml) |
| PostgreSQL ба migration | PostgreSQL өөрийн дотоод Service болон өгөгдөл хадгалах PVC-тэй. PostgreSQL бэлэн болсны дараа migration Job нь `dap_owner` эрхээр хүснэгтүүдийг бэлдэнэ. Backend дараа нь `dap_app` эрхээр холбогдоно. [postgres.yaml](postgres.yaml), [migrate.yaml](migrate.yaml) |
| Readiness probe | Pod бүрийн `GET /readyz` endpoint-д хандана. Backend PostgreSQL дахь migration-аар үүссэн хүснэгтийг уншиж чадаж байвал HTTP `200`, хандаж чадахгүй бол `503` буцаана. Service бэлэн Pod руу хүсэлт дамжуулна. [Backend тохиргоо](../../apps/reference-host/src/http/dev-server.ts) |

Нэг Pod дотор нэг backend контейнер ажиллана. Браузер Pod-ийн IP хаягийг мэдэх шаардлагагүй. Pod солигдсон ч Kubernetes Service-ийн нэр, порт хэвээр байна.

Backend болон migration Job нь `ai-support-agent-clean:minikube-v1` image-ийг хамт ашиглана. Image-ийг төслийн Dockerfile-аар build хийж, `minikube image load` командаар cluster-т оруулна. PostgreSQL-ийн role болон password bootstrap-ийг Compose, Minikube хоёрт хуваалцсан. `configure.mjs` нь DB холболт болон demo session-ийг Kubernetes Secret-ээр дамжуулж, NodePort-оор орж ирэх хүсэлтийн Host-ийг Minikube-ийн тодорхой IP болон портоор зөвшөөрнө. [Dockerfile](../docker/Dockerfile), [Bootstrap script](../../db/bootstrap/001_passwords.sh), [Лабораторийн тохиргоо](configure.mjs)

## Асаах, шалгах, унтраах

Командуудыг repository-ийн root хавтсаас ажиллуулна. Лабораторид ашигласан `minikube`, `kubectl` одоо ч `/tmp/dap-minikube-tools` дотор байвал шинэ терминалд эхний мөрөөр PATH-д нэмнэ. Өөрийн PATH-д суулгасан бол энэ мөр шаардлагагүй. [Minikube суулгах заавар](https://minikube.sigs.k8s.io/docs/start/), [kubectl суулгах заавар](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/)

### Өмнө байршуулсан cluster-ийг асаах

```bash
export PATH="/tmp/dap-minikube-tools:$PATH"
minikube start -p dap-lab --driver=docker
kubectl --context dap-lab wait --for=condition=Ready node/dap-lab --timeout=150s
kubectl --context dap-lab get nodes
kubectl --context dap-lab -n dap-lab rollout status deployment/dap-app --timeout=180s
kubectl --context dap-lab -n dap-lab get pods -l app=dap-app
```

Node `Ready`, backend-ийн гурван Pod тус бүр `1/1 Running` байвал апп бэлэн. Өмнө нь байршуулсан cluster-ийг `stop`-ын дараа асаахад YAML файлуудыг дахин apply хийх шаардлагагүй.

### Браузераар шалгах

```bash
minikube -p dap-lab -n dap-lab service dap-app --url
```

Терминалаа нээлттэй байлгаад гарсан URL-ийн ард `/readyz` нэмж браузераар нээнэ. `{"status":"ready"}` харагдвал Service-ээр дамжин backend-д амжилттай хүрч байна. Ижил URL-ийг ашиглан `POST /api/guidance` хүсэлт явуулахад HTTP `200`, `kind: "walkthrough"` хүлээнэ. [Guidance хүсэлтийн JSON жишээ](../../apps/reference-host/README.md#docker-lab)

### Унтраах

Service-ийн URL гаргасан терминал дээр `Ctrl+C` дарж tunnel-ийг хаана. Дараа нь cluster-ийг түр зогсооно. Байршуулсан тохиргоо болон PostgreSQL-ийн PVC-д хадгалсан өгөгдөл үлдэнэ.

```bash
minikube stop -p dap-lab
```

## Шинэ cluster дээр анх байрлуулах

Дараалал нь **cluster → image → PostgreSQL → migration → backend Deployment → Service**. Docker daemon ажиллаж, Minikube, kubectl, Node.js командууд PATH-д байгаа үед ажиллуулна.

```bash
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

Migration Job `Complete` болсны дараа backend Deployment-ийг apply хийнэ. PostgreSQL-ийн PVC-г ашиглах хугацаанд Git-д ороогүй `.env.k8s.local` файлыг хадгална. Энэ файлд PostgreSQL анх бэлтгэхэд ашигласан нууц үгс байна. 24 цагийн demo session дуусвал дээрх `configure.mjs` командыг дахин ажиллуулаад `k rollout restart deployment/dap-app` болон `k rollout status deployment/dap-app` ажиллуулна.

Docker image шинэчлэхдээ build, image load, Deployment болон migration Job-д шинэ tag ашиглана. Migration өөрчлөгдсөн бол шинэ нэртэй Job ашиглана.

## Self-healing туршилт ба оношилгоо

Эхлээд гурван Pod-ийн нэр, UID-г тэмдэглэнэ. Нэгийг устгаад шинэ Pod `1/1 Running` болтол ажиглана. `-w` командыг `Ctrl+C`-ээр дуусгаад нэр, UID-г дахин харна.

```bash
k() { kubectl --context dap-lab -n dap-lab "$@"; }
k get pods -l app=dap-app -o custom-columns=NAME:.metadata.name,UID:.metadata.uid
pod=$(k get pods -l app=dap-app -o jsonpath='{.items[0].metadata.name}')
k delete pod "$pod"
k get pods -l app=dap-app -w
k get pods -l app=dap-app -o custom-columns=NAME:.metadata.name,UID:.metadata.uid
```

| Асуудал | Шалгах команд |
| --- | --- |
| Cluster эсвэл Node бэлэн эсэх | `minikube status -p dap-lab`, `kubectl --context dap-lab get nodes` |
| Pod яагаад асахгүй эсвэл Ready болохгүй байгаа | `k describe pod <pod-name>`, `k get events --sort-by=.lastTimestamp` |
| Backend эхлэхдээ алдаа өгсөн | `k logs <pod-name>`. Дахин ассан бол `k logs <pod-name> --previous` |
| Migration дуусаагүй | `k get jobs`, `k logs job/dap-migrate` |
| Service-д бэлэн Pod холбогдсон эсэх | `k get svc dap-app`, `k get endpointslices -l kubernetes.io/service-name=dap-app` |

## Баталгаажуулалтын үр дүн

| Шалгалт | Ажигласан үр дүн |
| --- | --- |
| Cluster ба image | Node `Ready` болсон. `ai-support-agent-clean:minikube-v1` image cluster-т байсныг шалгасан. |
| Migration ба Deployment | `dap-migrate` Job `1/1 Complete`, гурван backend Pod `1/1 Running` болсон. |
| Service ба браузер | Service гурван endpoint-той болсон. Chrome-оор `/readyz` нээхэд `{"status":"ready"}` харагдсан. `POST /api/guidance` HTTP `200`, `kind: "walkthrough"` буцаасан. |
| Self-healing | `dap-app-5d86945545-7t942` Pod-ийг устгахад `dap-app-5d86945545-nlzlf` Pod шинэ UID-тай үүссэн. Бусад хоёр Pod хэвээр ажиллаж, нийт гурван Pod дахин Ready болсон. Service-ээр `/readyz` HTTP `200` буцаасан. |

[Pod UID болон командын дэлгэрэнгүй баримт](verification.md)
