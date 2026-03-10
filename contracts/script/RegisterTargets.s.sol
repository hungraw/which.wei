// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {rAgg} from "../src/rAgg.sol";

/// @notice Register bridge targets on a deployed rAgg instance.
///         Run with: forge script script/RegisterTargets.s.sol:RegisterTargets \
///                   --rpc-url $RPC --broadcast --private-key $PK \
///                   -s "run(address)" $RAGG_ADDRESS
contract RegisterTargets is Script {
    // ── Token bitmap constants ──────────────────────────────
    // tokenSymbols[0] = "USDC", tokenSymbols[1] = "USDT", tokenSymbols[2] = "ETH"
    uint16 constant USDC      = 1 << 0; // 0b001
    uint16 constant USDT      = 1 << 1; // 0b010
    uint16 constant ETH_TOKEN = 1 << 2; // 0b100
    uint16 constant USDC_USDT = USDC | USDT;
    uint16 constant ALL_TOKENS = USDC | USDT | ETH_TOKEN;

    // ── Chain bitmap constants ──────────────────────────────
    // chainIds: [1, 8453, 42161, 10, 137, 999, 56, 57073]
    //   idx:     0   1      2    3   4    5    6    7
    uint32 constant ALL_CHAINS   = (1 << 8) - 1; // 0xFF — all 8 bits
    uint32 constant NO_HYPEREVM  = ALL_CHAINS & ~uint32(1 << 5);
    uint32 constant NO_BSC       = ALL_CHAINS & ~uint32(1 << 6);
    uint32 constant NO_INK       = ALL_CHAINS & ~uint32(1 << 7);

    function run(address router) external {
        rAgg r = rAgg(payable(router));
        uint256 chainId = block.chainid;
        console.log("Registering targets on chain", chainId, "for router", router);

        vm.startBroadcast();

        // ── Across SpokePool (all 8 chains, different address each) ──
        _addAcross(r, chainId);

        // ── CCTP TokenMessengerV2 (same addr, 7/8 chains — no BSC) ──
        if (chainId != 56) {
            _addTarget(r, 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d, "CCTP", NO_BSC, USDC);
        }

        // ── cBridge (6/8 chains, different addr each) ──
        _addCbridge(r, chainId);

        // ── Stargate pools (chain-specific) ──
        _addStargate(r, chainId);

        // ── USDT0 OFT (6/8 chains, different addr each) ──
        _addUSDT0(r, chainId);

        // ── GasZip (same addr, all 8 chains) ──
        _addTarget(r, 0x391E7C679d29bD940d63be94AD22A25d25b5A604, "GasZip", ALL_CHAINS, ETH_TOKEN);

        // ── Mayan Forwarder (same addr, 7/8 chains — no Ink) ──
        if (chainId != 57073) {
            _addTarget(r, 0x337685fdaB40D39bd02028545a4FfA7D287cC3E2, "Mayan", NO_INK, USDC);
        }

        // ── deBridge DlnSource (same addr, 6/8 — no HyperEVM, no Ink) ──
        if (chainId != 999 && chainId != 57073) {
            _addTarget(r, 0xeF4fB24aD0916217251F553c0596F8Edc630EB66, "deBridge", NO_HYPEREVM & NO_INK, USDC_USDT);
        }

        // ── Synapse CCTP Router (same addr, 6/8 — no HyperEVM, no Ink) ──
        if (chainId != 999 && chainId != 57073) {
            _addTarget(r, 0xd5a597d6e7ddf373a92C8f477DAAA673b0902F48, "Synapse", NO_HYPEREVM & NO_INK, USDC);
        }

        // ── Orbiter Router (same addr, 7/8 — no HyperEVM) ──
        if (chainId != 999) {
            _addTarget(r, 0xe530d28960d48708CcF3e62Aa7B42A80bC427Aef, "Orbiter", NO_HYPEREVM, USDC);
        }

        // ── Relay Depository (same addr, all 8) ──
        _addTarget(r, 0x4cD00E387622C35bDDB9b4c962C136462338BC31, "Relay", ALL_CHAINS, USDC_USDT);

        // ── Eco Portal (same addr, 6/8 — no HyperEVM, no BSC) ──
        if (chainId != 999 && chainId != 56) {
            _addTarget(r, 0x399Dbd5DF04f83103F77A58cBa2B7c4d3cdede97, "Eco", NO_HYPEREVM & NO_BSC, USDC);
        }

        vm.stopBroadcast();
        console.log("Done.");
    }

    // ── Per-chain target helpers ─────────────────────────────

    function _addAcross(rAgg r, uint256 chainId) internal {
        if (chainId == 1)     _addTarget(r, 0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5, "Across", ALL_CHAINS, ALL_TOKENS);
        if (chainId == 8453)  _addTarget(r, 0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64, "Across", ALL_CHAINS, ALL_TOKENS);
        if (chainId == 42161) _addTarget(r, 0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A, "Across", ALL_CHAINS, ALL_TOKENS);
        if (chainId == 10)    _addTarget(r, 0x6f26Bf09B1C792e3228e5467807a900A503c0281, "Across", ALL_CHAINS, ALL_TOKENS);
        if (chainId == 137)   _addTarget(r, 0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096, "Across", ALL_CHAINS, ALL_TOKENS);
        if (chainId == 999)   _addTarget(r, 0x35E63eA3eb0fb7A3bc543C71FB66412e1F6B0E04, "Across", ALL_CHAINS, ALL_TOKENS);
        if (chainId == 56)    _addTarget(r, 0x4e8E101924eDE233C13e2D8622DC8aED2872d505, "Across", ALL_CHAINS, ALL_TOKENS);
        if (chainId == 57073) _addTarget(r, 0xeF684C38F94F48775959ECf2012D7E864ffb9dd4, "Across", ALL_CHAINS, ALL_TOKENS);
    }

    function _addCbridge(rAgg r, uint256 chainId) internal {
        if (chainId == 1)     _addTarget(r, 0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820, "cBridge", NO_HYPEREVM & NO_INK, USDC_USDT);
        if (chainId == 8453)  _addTarget(r, 0x7d43AABC515C356145049227CeE54B608342c0ad, "cBridge", NO_HYPEREVM & NO_INK, USDC_USDT);
        if (chainId == 42161) _addTarget(r, 0x1619DE6B6B20eD217a58d00f37B9d47C7663feca, "cBridge", NO_HYPEREVM & NO_INK, USDC_USDT);
        if (chainId == 10)    _addTarget(r, 0x9D39Fc627A6d9d9F8C831c16995b209548cc3401, "cBridge", NO_HYPEREVM & NO_INK, USDC_USDT);
        if (chainId == 137)   _addTarget(r, 0x88DCDC47D2f83a99CF0000FDF667A468bB958a78, "cBridge", NO_HYPEREVM & NO_INK, USDC_USDT);
        if (chainId == 56)    _addTarget(r, 0xdd90E5E87A2081Dcf0391920868eBc2FFB81a1aF, "cBridge", NO_HYPEREVM & NO_INK, USDC_USDT);
    }

    function _addStargate(rAgg r, uint256 chainId) internal {
        // Stargate USDC pool
        if (chainId == 1)     _addTarget(r, 0xc026395860Db2d07ee33e05fE50ed7bD583189C7, "Stargate USDC", ALL_CHAINS, USDC);
        if (chainId == 8453)  _addTarget(r, 0x27a16dc786820B16E5c9028b75B99F6f604b5d26, "Stargate USDC", ALL_CHAINS, USDC);
        if (chainId == 42161) _addTarget(r, 0xe8CDF27AcD73a434D661C84887215F7598e7d0d3, "Stargate USDC", ALL_CHAINS, USDC);
        if (chainId == 10)    _addTarget(r, 0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0, "Stargate USDC", ALL_CHAINS, USDC);
        if (chainId == 137)   _addTarget(r, 0x9Aa02D4Fae7F58b8E8f34c66E756cC734DAc7fe4, "Stargate USDC", ALL_CHAINS, USDC);
        if (chainId == 56)    _addTarget(r, 0x962Bd449E630b0d928f308Ce63f1A21F02576057, "Stargate USDC", ALL_CHAINS, USDC);
        if (chainId == 57073) _addTarget(r, 0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590, "Stargate USDC", ALL_CHAINS, USDC);

        // Stargate USDT pool (no Base, no HyperEVM)
        if (chainId == 1)     _addTarget(r, 0x933597a323Eb81cAe705C5bC29985172fd5A3973, "Stargate USDT", ALL_CHAINS, USDT);
        if (chainId == 42161) _addTarget(r, 0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0, "Stargate USDT", ALL_CHAINS, USDT);
        if (chainId == 10)    _addTarget(r, 0x19cFCE47eD54a88614648DC3f19A5980097007dD, "Stargate USDT", ALL_CHAINS, USDT);
        if (chainId == 137)   _addTarget(r, 0xd47b03ee6d86Cf251ee7860FB2ACf9f91B9fD4d7, "Stargate USDT", ALL_CHAINS, USDT);
        if (chainId == 56)    _addTarget(r, 0x138EB30f73BC423c6455C53df6D89CB01d9eBc63, "Stargate USDT", ALL_CHAINS, USDT);

        // Stargate ETH pool (only ETH, Base, Arb, OP)
        if (chainId == 1)     _addTarget(r, 0x77b2043768d28E9C9aB44E1aBfC95944bcE57931, "Stargate ETH", ALL_CHAINS, ETH_TOKEN);
        if (chainId == 8453)  _addTarget(r, 0xdc181Bd607330aeeBEF6ea62e03e5e1Fb4B6F7C7, "Stargate ETH", ALL_CHAINS, ETH_TOKEN);
        if (chainId == 42161) _addTarget(r, 0xA45B5130f36CDcA45667738e2a258AB09f4A5f7F, "Stargate ETH", ALL_CHAINS, ETH_TOKEN);
        if (chainId == 10)    _addTarget(r, 0xe8CDF27AcD73a434D661C84887215F7598e7d0d3, "Stargate ETH", ALL_CHAINS, ETH_TOKEN);
    }

    function _addUSDT0(rAgg r, uint256 chainId) internal {
        if (chainId == 1)     _addTarget(r, 0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee, "USDT0", ALL_CHAINS, USDT);
        if (chainId == 42161) _addTarget(r, 0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92, "USDT0", ALL_CHAINS, USDT);
        if (chainId == 10)    _addTarget(r, 0xF03b4d9AC1D5d1E7c4cEf54C2A313b9fe051A0aD, "USDT0", ALL_CHAINS, USDT);
        if (chainId == 137)   _addTarget(r, 0x6BA10300f0DC58B7a1e4c0e41f5daBb7D7829e13, "USDT0", ALL_CHAINS, USDT);
        if (chainId == 999)   _addTarget(r, 0x904861a24F30EC96ea7CFC3bE9EA4B476d237e98, "USDT0", ALL_CHAINS, USDT);
        if (chainId == 57073) _addTarget(r, 0x1cB6De532588fCA4a21B7209DE7C456AF8434A65, "USDT0", ALL_CHAINS, USDT);
    }

    // ── Core helper ─────────────────────────────────────────

    function _addTarget(rAgg r, address target, bytes26 name, uint32 chains, uint16 tokens) internal {
        if (r.approvedTargets(target)) {
            console.log("  SKIP (already approved):", target);
            return;
        }
        r.addTarget(target, name, chains, tokens);
        console.log("  Added:", target);
    }
}
