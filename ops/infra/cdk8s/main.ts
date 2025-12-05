import { App } from 'cdk8s';
import { RaidChainChart, RaidChainProps } from './charts/raidchain';

const app = new App();

const config: RaidChainProps = {
  releaseName: 'raidchain', // HelmのRelease Nameに相当
  devMode: true,
  storageSize: '10Gi',
  chains: [
    { name: 'gwc', type: 'gwc' },
    { name: 'mdsc', type: 'mdsc' },
    { name: 'fdsc-0', type: 'fdsc' },
  ],
  chainTypes: {
    gwc: { repository: 'raidchain/gwc', tag: 'latest' },
    mdsc: { repository: 'raidchain/mdsc', tag: 'latest' },
    fdsc: { repository: 'raidchain/fdsc', tag: 'latest' },
  },
  relayer: {
    repository: 'raidchain/relayer',
    tag: 'latest',
    pullPolicy: 'IfNotPresent',
  }
};

new RaidChainChart(app, 'raidchain', config);

app.synth();