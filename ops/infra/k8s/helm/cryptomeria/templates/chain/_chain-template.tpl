{{- define "cryptomeria.chain.statefulset-template" -}}
{{- $chain := . -}}

{{- $component := $chain.name -}}
{{- if and (eq $chain.name "fdsc") (isset $chain "index") -}}
  {{- $component = printf "fdsc-%d" $chain.index -}}
{{- end -}}

---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ include "cryptomeria.fullname" $ }}}-{{ $component }}
  namespace: {{ $.Release.Namespace }}
  labels:
    {{- include "cryptomeria.labels" $ | nindent 4 }}
    app.kubernetes.io/component: {{ $chain.name }}
    app.kubernetes.io/category: chain
spec:
  serviceName: {{ include "cryptomeria.fullname" $ }}-{{ $chain.name }}-headless
  replicas: 1
  selector:
    matchLabels:
      {{- include "cryptomeria.selectorLabels" $ | nindent 6 }}
      app.kubernetes.io/component: {{ $chain.name }}
  template:
    metadata:
      labels:
        {{- include "cryptomeria.selectorLabels" $ | nindent 8 }}
        app.kubernetes.io/component: {{ $chain.name }}
        app.kubernetes.io/category: chain
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
            name: {{ include "cryptomeria.fullname" $ }}-scripts
            defaultMode: 0755
        - name: mnemonics
          secret:
            secretName: {{ include "cryptomeria.fullname" $ }}-mnemonics
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ "ReadWriteOnce" ]
        resources:
          requests:
            storage: {{ $chain.persistence.size }}
{{- end -}}