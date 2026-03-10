// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {rAgg} from "../src/rAgg.sol";

/// @notice Deploy rAgg via CREATE2 deterministic deployment proxy.
///         Uses empty target arrays so initcode hash is identical across all chains.
///         Bridge targets are added post-deploy via addTarget().
contract DeployRAgg is Script {

    function run() external {
        address deployer = msg.sender;
        bytes32 salt = vm.envOr("SALT", bytes32(uint256(0)));

        // Chain metadata — same on all chains for deterministic address.
        uint256[] memory chainIds = new uint256[](8);
        chainIds[0] = 1;      // Ethereum
        chainIds[1] = 8453;   // Base
        chainIds[2] = 42161;  // Arbitrum
        chainIds[3] = 10;     // Optimism
        chainIds[4] = 137;    // Polygon
        chainIds[5] = 999;    // HyperEVM
        chainIds[6] = 56;     // BSC
        chainIds[7] = 57073;  // Ink

        bytes32[] memory tokenSymbols = new bytes32[](3);
        tokenSymbols[0] = "USDC";
        tokenSymbols[1] = "USDT";
        tokenSymbols[2] = "ETH";

        // Empty arrays — targets added post-deploy per chain.
        address[] memory targets = new address[](0);
        bytes26[] memory names = new bytes26[](0);
        uint32[]  memory chains = new uint32[](0);
        uint16[]  memory tokens = new uint16[](0);

        // Build initcode.
        bytes memory initcode = abi.encodePacked(
            type(rAgg).creationCode,
            abi.encode(deployer, chainIds, tokenSymbols, targets, names, chains, tokens)
        );

        // Predict address.
        address predicted = _predictCreate2(salt, keccak256(initcode));
        console.log("Predicted address:", predicted);
        console.log("Salt:", vm.toString(salt));
        console.log("Deployer/Owner:", deployer);

        // Check if already deployed.
        if (predicted.code.length > 0) {
            console.log("Already deployed at", predicted);
            return;
        }

        vm.startBroadcast();

        // Deploy via CREATE2 factory.
        (bool success, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(salt, initcode));
        require(success && ret.length == 20, "CREATE2 deploy failed");

        address deployed;
        assembly { deployed := mload(add(ret, 20)) }
        require(deployed == predicted, "Address mismatch");

        console.log("Deployed rAgg at:", deployed);

        vm.stopBroadcast();
    }

    function _predictCreate2(bytes32 salt, bytes32 initcodeHash) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, initcodeHash))))
        );
    }
}
