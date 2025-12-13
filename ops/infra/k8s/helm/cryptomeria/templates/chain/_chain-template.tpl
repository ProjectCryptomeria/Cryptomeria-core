{{- define "cryptomeria.chain.statefulset-template" -}}
{{- $context := . -}}
{{- $chain := .Value -}}
{{- $release := .Release -}}

{{- $component := $chain.name -}}

{{- /* FDSCノード（fdsc-0, fdsc-1...）の場合、名前をインスタンスIDに置き換える */ -}}
{{- if and (eq $chain.name "fdsc") (ge $chain.index 0) -}}
  {{- $component = printf "fdsc-%d" $chain.index -}}
{{- end -}}

---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ include "cryptomeria.fullname" $context }}-{{ $component }}
  namespace: {{ $.Release.Namespace }}
  labels:
    {{- include "cryptomeria.labels" $context | nindent 4 }}
    app.kubernetes.io/component: {{ $chain.name }}
    app.kubernetes.io/category: chain
    app.kubernetes.io/instance: {{ $component }}
spec:
  serviceName: {{ include "cryptomeria.fullname" $context }}-chain-headless
  replicas: 1
  selector:
    matchLabels:
      {{- include "cryptomeria.selectorLabels" $context | nindent 6 }}
      app.kubernetes.io/component: {{ $chain.name }}
      # ▼▼▼ 修正: セレクタにもユニークなインスタンス名を追加して競合を回避 ▼▼▼
      app.kubernetes.io/instance: {{ $component }}
  template:
    metadata:
      labels:
        {{- include "cryptomeria.selectorLabels" $context | nindent 8 }}
        app.kubernetes.io/component: {{ $chain.name }}
        app.kubernetes.io/category: chain
        # Pod側のラベル定義（これは前回既に追加済み）
        app.kubernetes.io/instance: {{ $component }}
    spec:
      containers:
        - name: chain
          image: "{{ $chain.image.repository }}:{{ $chain.image.tag }}"
          imagePullPolicy: {{ $chain.image.pullPolicy }}
          command: ["/bin/sh", "-c", "/scripts/entrypoint-chain.sh"]
    
          env:
            - name: CHAIN_APP_NAME
              value: "{{ $chain.name }}"
            - name: CHAIN_INSTANCE_NAME
              value: {{ $component | quote }}
            - name: DENOM
              value: "uatom"
          ports:
            - containerPort: {{ $chain.service.rpcPort }}
              name: rpc
            - containerPort: {{ $chain.service.grpcPort }}
              name: grpc
            - containerPort: {{ $chain.service.apiPort }}
              name: api
          volumeMounts:
            - name: data
              mountPath: /home/{{ $chain.name }}/.{{ $chain.name }}
            - name: scripts
              mountPath: /scripts
            - name: mnemonics
              mountPath: /etc/mnemonics
              readOnly: true
          resources:
            {{- toYaml $chain.resources | nindent 12 }}
      volumes:
        - name: scripts
          configMap:
            name: {{ include "cryptomeria.fullname" $context }}-scripts
            defaultMode: 0755
        - name: mnemonics
          secret:
            secretName: {{ include "cryptomeria.fullname" $context }}-mnemonics
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ "ReadWriteOnce" ]
        resources:
          requests:
            storage: {{ $chain.persistence.size }}
{{ end }}