# which.wei

cross-chain bridge aggregator suite. all client-side, no backend.

**demo: [which.wei.limo](https://which.wei.limo)**

## supported right neow

**Ethereum · Base · Arbitrum · Optimism · Polygon · BNB Chain · HyperEVM · Ink**

**USDC · USDT · USDT0 · ETH**

**Across · CCTP · deBridge · Relay · Stargate · cBridge · Synapse · Gas.zip · Orbiter · Mayan · Eco · USDT0**

## tek

- **fe:** TypeScript + Vite, vanilla DOM
- **contract:** [rAgg](contracts/src/rAgg.sol)
- **hosting:** IPFS served through WNS (`wei.domains`)

## deploy

builds go to IPFS via [Filebase](https://filebase.com/), served through `which.wei` WNS name.

push to `main` triggers the [deploy workflow](.github/workflows/deploy.yml). needs these github secrets:

- `FILEBASE_KEY`, `FILEBASE_SECRET`, `FILEBASE_BUCKET` — s3-compatible IPFS pinning
- `WEI_DEPLOYER_KEY` — private key for updating the WNS contenthash

manual deploy:

```bash
npm run build
npm run deploy   # needs env vars above
```

## license

[MIT](LICENSE)
