FROM nginx:alpine

# Install jq (and ca-certificates for TLS downloads if you later add curl/wget)
RUN apk add --no-cache jq ca-certificates

# (optional) sanity check at build time
RUN jq --version

# nginx default entrypoint/cmd are kept
