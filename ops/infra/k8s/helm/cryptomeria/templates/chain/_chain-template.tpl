{{- define "cryptomeria.chain.statefulset-template" -}}
{{- $context := . -}}
{{- $chain := .Value -}} # ★修正: 渡されたディクショナリの "Value" キーから設定オブジェクトを取得
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
  name: {{ include "cryptomeria.fullname" $context }}-{{ $component }} # $context を使用
  namespace: {{ $.Release.Namespace }} # $.Release はグローバルな Release オブジェクトを参照
  labels:
    {{- include "cryptomeria.labels" $context | nindent 4 }}
    app.kubernetes.io/component: {{ $chain.name }}
    app.kubernetes.io/category: chain
spec:
  serviceName: {{ include "cryptomeria.fullname" $context }}-{{ $chain.name }}-headless
  replicas: 1
  selector:
    matchLabels:
      {{- include "cryptomeria.selectorLabels" $context | nindent 6 }}
      app.kubernetes.io/component: {{ $chain.name }}
  template:
    metadata:
      labels:
        {{- include "cryptomeria.selectorLabels" $context | nindent 8 }}
        app.kubernetes.io/component: {{ $chain.name }}
        app.kubernetes.io/category: chain
    spec:
      containers:
        - name: chain
          # Imageの参照は $chain から行うため問題なし
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
{{- end -}}