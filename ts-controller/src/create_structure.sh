#!/bin/bash

# Exit on error
set -e

echo "Creating directory structure and files within controller/src..."

# Create core directories
mkdir -p core
mkdir -p infrastructure
mkdir -p strategies/communication
mkdir -p strategies/upload
mkdir -p strategies/confirmation
mkdir -p strategies/download
mkdir -p strategies/verification
mkdir -p experiments/configs
mkdir -p experiments/results
mkdir -p types
mkdir -p utils

# Create core files
touch core/ExperimentRunner.ts
touch core/ChainManager.ts
touch core/PerformanceTracker.ts

# Create infrastructure files
touch infrastructure/InfrastructureService.ts

# Create strategy interface and implementation files
touch strategies/communication/ICommunicationStrategy.ts
touch strategies/communication/HttpCommunicationStrategy.ts
touch strategies/communication/WebSocketCommunicationStrategy.ts

touch strategies/upload/IUploadStrategy.ts
touch strategies/upload/SequentialUploadStrategy.ts
touch strategies/upload/RoundRobinUploadStrategy.ts
touch strategies/upload/AutoDistributeUploadStrategy.ts
# touch strategies/upload/PipelinedAutoDistributeUploadStrategy.ts # Optional

touch strategies/confirmation/IConfirmationStrategy.ts
touch strategies/confirmation/PollingConfirmationStrategy.ts
touch strategies/confirmation/TxEventConfirmationStrategy.ts
# touch strategies/confirmation/TxEventSubscriber.ts # Likely internal to TxEventConfirmationStrategy

touch strategies/download/IDownloadStrategy.ts
touch strategies/download/HttpDownloadStrategy.ts

touch strategies/verification/IVerificationStrategy.ts
touch strategies/verification/BufferVerificationStrategy.ts
# touch strategies/verification/FileVerificationStrategy.ts # Optional

# Create experiment files
touch experiments/config.ts
touch experiments/results/.gitkeep # Keep the directory even if empty
# Example config files (you can add more as needed)
touch experiments/configs/case1-limit-test.config.ts
touch experiments/configs/case2-manual.config.ts
touch experiments/configs/case3-roundrobin.config.ts
touch experiments/configs/case4-auto.config.ts
touch experiments/configs/case5-scalability.config.ts
touch experiments/configs/case6-chunksize.config.ts

# Create type files
touch types/index.ts
touch types/cosmos.ts
touch types/experiment.ts

# Create utility files
touch utils/logger.ts
touch utils/retry.ts

# Create root files
touch registry.ts
touch run-experiment.ts

echo "✅ Directory structure and files created successfully."