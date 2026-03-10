// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {rAgg} from "../src/rAgg.sol";

/// @notice Test the full deploy → register targets flow on a mainnet fork.
contract DeployFlowTest is Test {

    function test_fork_deployAndRegister() public {
        address owner = makeAddr("owner");
        bytes32 salt = bytes32(0);

        // Build constructor args — same as Deploy.s.sol.
        uint256[] memory chainIds = new uint256[](8);
        chainIds[0] = 1; chainIds[1] = 8453; chainIds[2] = 42161; chainIds[3] = 10;
        chainIds[4] = 137; chainIds[5] = 999; chainIds[6] = 56; chainIds[7] = 57073;

        bytes32[] memory tokenSymbols = new bytes32[](3);
        tokenSymbols[0] = "USDC"; tokenSymbols[1] = "USDT"; tokenSymbols[2] = "ETH";

        address[] memory targets = new address[](0);
        bytes26[] memory names = new bytes26[](0);
        uint32[]  memory chains = new uint32[](0);
        uint16[]  memory tokens = new uint16[](0);

        bytes memory initcode = abi.encodePacked(
            type(rAgg).creationCode,
            abi.encode(owner, chainIds, tokenSymbols, targets, names, chains, tokens)
        );

        // Predict address.
        address predicted = address(uint160(uint256(keccak256(
            abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, keccak256(initcode))
        ))));

        // Deploy via CREATE2.
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(salt, initcode));
        require(ok && ret.length == 20, "CREATE2 failed");
        address deployed;
        assembly { deployed := mload(add(ret, 20)) }
        assertEq(deployed, predicted, "address mismatch");

        rAgg router = rAgg(payable(deployed));

        // Verify initial state.
        assertEq(router.owner(), owner);
        assertEq(router.getChainIds().length, 8);
        assertEq(router.getTokenSymbols().length, 3);
        assertEq(router.getTargets().length, 0);

        // Register Ethereum mainnet targets (as owner).
        vm.startPrank(owner);

        // Across SpokePool
        router.addTarget(0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5, "Across", uint32((1 << 8) - 1), 7);
        assertTrue(router.approvedTargets(0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5));

        // CCTP TokenMessengerV2
        router.addTarget(0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d, "CCTP", uint32((1 << 8) - 1) & ~uint32(1 << 6), 1);
        assertTrue(router.approvedTargets(0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d));

        // GasZip
        router.addTarget(0x391E7C679d29bD940d63be94AD22A25d25b5A604, "GasZip", uint32((1 << 8) - 1), 4);
        assertTrue(router.approvedTargets(0x391E7C679d29bD940d63be94AD22A25d25b5A604));

        // deBridge
        router.addTarget(0xeF4fB24aD0916217251F553c0596F8Edc630EB66, "deBridge", uint32((1 << 8) - 1) & ~uint32(1 << 5) & ~uint32(1 << 7), 3);
        assertTrue(router.approvedTargets(0xeF4fB24aD0916217251F553c0596F8Edc630EB66));

        // Stargate USDC
        router.addTarget(0xc026395860Db2d07ee33e05fE50ed7bD583189C7, "Stargate USDC", uint32((1 << 8) - 1), 1);
        assertTrue(router.approvedTargets(0xc026395860Db2d07ee33e05fE50ed7bD583189C7));

        // Verify target count
        assertEq(router.getTargets().length, 5);

        // Verify metadata
        (bytes26 name, uint32 supportedChains, uint16 supportedTokens) = router.bridgeMeta(0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5);
        assertEq(name, bytes26("Across"));
        assertEq(supportedChains, 255); // all 8 chains
        assertEq(supportedTokens, 7);   // USDC | USDT | ETH

        // Remove a target
        router.removeTarget(0xc026395860Db2d07ee33e05fE50ed7bD583189C7);
        assertFalse(router.approvedTargets(0xc026395860Db2d07ee33e05fE50ed7bD583189C7));

        // Re-add it
        router.addTarget(0xc026395860Db2d07ee33e05fE50ed7bD583189C7, "Stargate USDC", uint32((1 << 8) - 1), 1);
        assertTrue(router.approvedTargets(0xc026395860Db2d07ee33e05fE50ed7bD583189C7));

        vm.stopPrank();

        console.log("Deploy + register flow verified at:", deployed);
    }
}
