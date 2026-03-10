// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test, Vm} from "forge-std/Test.sol";
import {rAgg} from "../src/rAgg.sol";

/// @dev Minimal ERC20 mock for testing, with configurable non-standard behavior.
contract MockERC20 {
    string public name = "Mock";
    string public symbol = "MCK";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Non-standard ERC20 that doesn't return bool (like USDT on mainnet).
contract MockUSDT {
    string public name = "Tether";
    string public symbol = "USDT";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    // USDT approve: requires current allowance to be 0 first (non-standard).
    function approve(address spender, uint256 amount) external {
        require(amount == 0 || allowance[msg.sender][spender] == 0, "reset first");
        allowance[msg.sender][spender] = amount;
        // No return value!
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        // No return value!
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        // No return value!
    }
}

/// @dev Mock bridge target that accepts ERC20 + ETH.
contract MockBridge {
    event BridgeCalled(address token, uint256 amount, uint256 destChainId, address recipient);

    // Simulate a bridge deposit: pull tokens from caller (the router) and emit event.
    function deposit(address token, uint256 amount, uint256 destChainId, address recipient) external payable {
        MockERC20(token).transferFrom(msg.sender, address(this), amount);
        emit BridgeCalled(token, amount, destChainId, recipient);
    }

    // ETH-only bridge deposit.
    function depositETH(uint256 destChainId, address recipient) external payable {
        emit BridgeCalled(address(0), msg.value, destChainId, recipient);
    }

    // Deposit that takes more ETH than needed (to test refund).
    function depositPartialETH(uint256 destChainId, address recipient, uint256 needed) external payable {
        require(msg.value >= needed, "not enough");
        // Send back excess.
        if (msg.value > needed) {
            (bool ok,) = msg.sender.call{value: msg.value - needed}("");
            require(ok);
        }
        emit BridgeCalled(address(0), needed, destChainId, recipient);
    }

    // Deposit that doesn't use all tokens (to test leftover refund).
    function depositPartialERC20(address token, uint256 pullAmount, uint256 destChainId, address recipient) external {
        MockERC20(token).transferFrom(msg.sender, address(this), pullAmount);
        emit BridgeCalled(token, pullAmount, destChainId, recipient);
    }

    // Always reverts (to test bridge failure handling).
    function depositRevert() external payable {
        revert("bridge failed");
    }

    receive() external payable {}
}

/// @dev Mock bridge for USDT (non-standard ERC20).
contract MockUSDTBridge {
    event BridgeCalled(address token, uint256 amount, uint256 destChainId, address recipient);

    function deposit(address token, uint256 amount, uint256 destChainId, address recipient) external {
        MockUSDT(token).transferFrom(msg.sender, address(this), amount);
        emit BridgeCalled(token, amount, destChainId, recipient);
    }
}

/// @dev Contract that rejects ETH (for testing refund failure edge case).
contract ETHRejecter {
    receive() external payable {
        revert("no ETH");
    }
}

/// @dev Mock Permit2 that simulates SignatureTransfer.permitTransferFrom.
///      Deployed at the canonical Permit2 address via vm.etch in tests.
contract MockPermit2 {
    event PermitTransferCalled(address token, uint256 amount, uint256 nonce, uint256 deadline, address owner, address to);

    function permitTransferFrom(
        IPermit2Structs.PermitTransferFrom calldata permit,
        IPermit2Structs.SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata /* signature */
    ) external {
        // Simulate: transfer tokens from owner to transferDetails.to
        MockERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
        emit PermitTransferCalled(
            permit.permitted.token, transferDetails.requestedAmount,
            permit.nonce, permit.deadline, owner, transferDetails.to
        );
    }
}

/// @dev Minimal struct definitions matching IPermit2 interface for the mock.
library IPermit2Structs {
    struct TokenPermissions { address token; uint256 amount; }
    struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }
    struct SignatureTransferDetails { address to; uint256 requestedAmount; }
}

contract rAggTest is Test {
    rAgg public router;
    MockERC20 public token;
    MockUSDT public usdt;
    MockBridge public bridge;
    MockUSDTBridge public usdtBridge;

    address owner = address(0xBEEF);
    address user = address(0xCAFE);
    address notOwner = address(0xDEAD);

    // Legend constants for tests.
    uint256[] chainIdsList;
    bytes32[] tokenSymbolsList;

    function setUp() public {
        token = new MockERC20();
        usdt = new MockUSDT();
        bridge = new MockBridge();
        usdtBridge = new MockUSDTBridge();

        // Bitmap legends.
        chainIdsList = new uint256[](3);
        chainIdsList[0] = 1;      // Ethereum
        chainIdsList[1] = 8453;   // Base
        chainIdsList[2] = 42161;  // Arbitrum

        tokenSymbolsList = new bytes32[](2);
        tokenSymbolsList[0] = bytes32("USDC");
        tokenSymbolsList[1] = bytes32("USDT");

        // Targets + metadata.
        address[] memory targets = new address[](2);
        targets[0] = address(bridge);
        targets[1] = address(usdtBridge);

        bytes26[] memory names = new bytes26[](2);
        names[0] = bytes26("mockbridge");
        names[1] = bytes26("mockusdt");

        uint32[] memory chains = new uint32[](2);
        chains[0] = 0x07; // all 3 chains
        chains[1] = 0x03; // Ethereum + Base only

        uint16[] memory tokens = new uint16[](2);
        tokens[0] = 0x03; // USDC + USDT
        tokens[1] = 0x02; // USDT only

        vm.prank(owner);
        router = new rAgg(owner, chainIdsList, tokenSymbolsList, targets, names, chains, tokens);
    }

    /*//////////////////////////////////////////////////////////////
                           DEPLOYMENT TESTS
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsOwner() public view {
        assertEq(router.owner(), owner);
    }

    function test_constructor_setsTargets() public view {
        assertTrue(router.approvedTargets(address(bridge)));
        assertTrue(router.approvedTargets(address(usdtBridge)));
        assertFalse(router.approvedTargets(address(0x1234)));
    }

    function test_constructor_emitsTargetAdded() public {
        address[] memory targets = new address[](1);
        targets[0] = address(0x9999);
        bytes26[] memory names = new bytes26[](1);
        names[0] = bytes26("test");
        uint32[] memory chains = new uint32[](1);
        chains[0] = 0x07;
        uint16[] memory tokens = new uint16[](1);
        tokens[0] = 0x03;

        vm.expectEmit(true, false, false, true);
        emit rAgg.TargetAdded(address(0x9999), bytes26("test"), 0x07, 0x03);
        new rAgg(owner, chainIdsList, tokenSymbolsList, targets, names, chains, tokens);
    }

    function test_constructor_revertsLengthMismatch() public {
        address[] memory targets = new address[](2);
        targets[0] = address(0x9999);
        targets[1] = address(0x8888);
        bytes26[] memory names = new bytes26[](1); // length mismatch
        names[0] = bytes26("test");
        uint32[] memory chains = new uint32[](2);
        uint16[] memory tokens = new uint16[](2);

        vm.expectRevert(rAgg.InvalidTarget.selector);
        new rAgg(owner, chainIdsList, tokenSymbolsList, targets, names, chains, tokens);
    }

    function test_constructor_revertsLegendOverflow_chains() public {
        uint256[] memory tooManyChains = new uint256[](33);
        for (uint256 i; i < tooManyChains.length; ++i) {
            tooManyChains[i] = i + 1;
        }

        bytes32[] memory symbols = new bytes32[](1);
        symbols[0] = bytes32("USDC");

        address[] memory targets = new address[](0);
        bytes26[] memory names = new bytes26[](0);
        uint32[] memory chains = new uint32[](0);
        uint16[] memory tokens = new uint16[](0);

        vm.expectRevert(rAgg.BitmapOverflow.selector);
        new rAgg(owner, tooManyChains, symbols, targets, names, chains, tokens);
    }

    function test_constructor_revertsLegendOverflow_tokens() public {
        uint256[] memory chainsList = new uint256[](1);
        chainsList[0] = 1;

        bytes32[] memory tooManySymbols = new bytes32[](17);
        for (uint256 i; i < tooManySymbols.length; ++i) {
            tooManySymbols[i] = bytes32(i + 1);
        }

        address[] memory targets = new address[](0);
        bytes26[] memory names = new bytes26[](0);
        uint32[] memory chains = new uint32[](0);
        uint16[] memory tokens = new uint16[](0);

        vm.expectRevert(rAgg.BitmapOverflow.selector);
        new rAgg(owner, chainsList, tooManySymbols, targets, names, chains, tokens);
    }

    /*//////////////////////////////////////////////////////////////
                         BRIDGE ERC20 TESTS
    //////////////////////////////////////////////////////////////*/

    function test_bridgeERC20_basic() public {
        uint256 amount = 1000e18;
        token.mint(user, amount);

        vm.startPrank(user);
        token.approve(address(router), amount);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.deposit, (address(token), amount, 8453, user)
        );

        vm.expectEmit(true, true, true, true);
        emit rAgg.BridgeInitiated(user, address(bridge), address(token), amount, 8453);

        router.bridgeERC20(address(bridge), address(token), amount, 8453, calldata_);
        vm.stopPrank();

        assertEq(token.balanceOf(user), 0);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(bridge)), amount);
    }

    function test_bridgeERC20_refundsLeftoverTokens() public {
        uint256 amount = 1000e18;
        uint256 pullAmount = 800e18; // Bridge only takes 800.
        token.mint(user, amount);

        vm.startPrank(user);
        token.approve(address(router), amount);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.depositPartialERC20, (address(token), pullAmount, 8453, user)
        );

        router.bridgeERC20(address(bridge), address(token), amount, 8453, calldata_);
        vm.stopPrank();

        // User gets 200 back, bridge gets 800, router holds 0.
        assertEq(token.balanceOf(user), 200e18);
        assertEq(token.balanceOf(address(bridge)), pullAmount);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_bridgeERC20_revertsOnUnapprovedTarget() public {
        token.mint(user, 1000e18);
        vm.startPrank(user);
        token.approve(address(router), 1000e18);

        vm.expectRevert(rAgg.TargetNotApproved.selector);
        router.bridgeERC20(address(0x9999), address(token), 1000e18, 8453, "");
        vm.stopPrank();
    }

    function test_bridgeERC20_revertsOnBridgeFailure() public {
        uint256 amount = 1000e18;
        token.mint(user, amount);

        vm.startPrank(user);
        token.approve(address(router), amount);

        bytes memory calldata_ = abi.encodeCall(MockBridge.depositRevert, ());

        vm.expectRevert("bridge failed");
        router.bridgeERC20(address(bridge), address(token), amount, 8453, calldata_);
        vm.stopPrank();
    }

    function test_bridgeERC20_resetsApproval() public {
        uint256 amount = 1000e18;
        token.mint(user, amount);

        vm.startPrank(user);
        token.approve(address(router), amount);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.deposit, (address(token), amount, 8453, user)
        );

        router.bridgeERC20(address(bridge), address(token), amount, 8453, calldata_);
        vm.stopPrank();

        // Router's allowance to bridge should be 0 after tx.
        assertEq(token.allowance(address(router), address(bridge)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                      BRIDGE ERC20 — USDT (NON-STANDARD)
    //////////////////////////////////////////////////////////////*/

    function test_bridgeERC20_USDT_nonStandard() public {
        uint256 amount = 1000e6;
        usdt.mint(user, amount);

        vm.startPrank(user);
        usdt.approve(address(router), amount);

        bytes memory calldata_ = abi.encodeCall(
            MockUSDTBridge.deposit, (address(usdt), amount, 8453, user)
        );

        router.bridgeERC20(address(usdtBridge), address(usdt), amount, 8453, calldata_);
        vm.stopPrank();

        assertEq(usdt.balanceOf(address(usdtBridge)), amount);
        assertEq(usdt.balanceOf(address(router)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                        BRIDGE NATIVE ETH TESTS
    //////////////////////////////////////////////////////////////*/

    function test_bridgeNative_basic() public {
        uint256 amount = 1 ether;
        vm.deal(user, amount);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.depositETH, (8453, user)
        );

        vm.prank(user);
        router.bridgeNative{value: amount}(address(bridge), 8453, calldata_);

        assertEq(address(bridge).balance, amount);
        assertEq(address(router).balance, 0);
    }

    function test_bridgeNative_refundsExcess() public {
        uint256 sent = 2 ether;
        uint256 needed = 1 ether;
        vm.deal(user, sent);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.depositPartialETH, (8453, user, needed)
        );

        uint256 userBalBefore = user.balance;
        vm.prank(user);
        router.bridgeNative{value: sent}(address(bridge), 8453, calldata_);

        assertEq(address(bridge).balance, needed);
        // User gets excess back.
        assertEq(user.balance, userBalBefore - sent + (sent - needed));
        assertEq(address(router).balance, 0);
    }

    function test_bridgeNative_revertsOnUnapprovedTarget() public {
        vm.deal(user, 1 ether);
        vm.prank(user);
        vm.expectRevert(rAgg.TargetNotApproved.selector);
        router.bridgeNative{value: 1 ether}(address(0x9999), 8453, "");
    }

    function test_bridgeNative_revertsOnBridgeFailure() public {
        vm.deal(user, 1 ether);

        bytes memory calldata_ = abi.encodeCall(MockBridge.depositRevert, ());

        vm.prank(user);
        vm.expectRevert("bridge failed");
        router.bridgeNative{value: 1 ether}(address(bridge), 8453, calldata_);
    }

    /*//////////////////////////////////////////////////////////////
                           ADMIN TESTS
    //////////////////////////////////////////////////////////////*/

    function test_addTarget() public {
        address newTarget = address(0x1111);
        assertFalse(router.approvedTargets(newTarget));

        vm.expectEmit(true, false, false, true);
        emit rAgg.TargetAdded(newTarget, bytes26("newtarget"), 0x05, 0x01);

        vm.prank(owner);
        router.addTarget(newTarget, bytes26("newtarget"), 0x05, 0x01);

        assertTrue(router.approvedTargets(newTarget));
    }

    function test_removeTarget() public {
        assertTrue(router.approvedTargets(address(bridge)));

        vm.expectEmit(true, false, false, false);
        emit rAgg.TargetRemoved(address(bridge));

        vm.prank(owner);
        router.removeTarget(address(bridge));

        assertFalse(router.approvedTargets(address(bridge)));
    }

    function test_addTarget_onlyOwner() public {
        vm.prank(notOwner);
        vm.expectRevert(rAgg.Unauthorized.selector);
        router.addTarget(address(0x1111), bytes26("x"), 0x01, 0x01);
    }

    function test_removeTarget_onlyOwner() public {
        vm.prank(notOwner);
        vm.expectRevert(rAgg.Unauthorized.selector);
        router.removeTarget(address(bridge));
    }

    function test_transferOwnership() public {
        vm.prank(owner);
        router.transferOwnership(notOwner);
        assertEq(router.owner(), notOwner);
    }

    function test_transferOwnership_onlyOwner() public {
        vm.prank(notOwner);
        vm.expectRevert(rAgg.Unauthorized.selector);
        router.transferOwnership(notOwner);
    }

    function test_transferOwnership_blocksZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(rAgg.ZeroAddress.selector);
        router.transferOwnership(address(0));
    }

    function test_addTarget_blocksZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(rAgg.InvalidTarget.selector);
        router.addTarget(address(0), bytes26("x"), 0x01, 0x01);
    }

    function test_addTarget_blocksSelf() public {
        vm.prank(owner);
        vm.expectRevert(rAgg.InvalidTarget.selector);
        router.addTarget(address(router), bytes26("x"), 0x01, 0x01);
    }

    /*//////////////////////////////////////////////////////////////
                          RESCUE TESTS
    //////////////////////////////////////////////////////////////*/

    function test_rescueToken_ERC20() public {
        // Force tokens into the router (simulating edge-case stuck tokens).
        token.mint(address(router), 500e18);

        vm.prank(owner);
        router.rescueToken(address(token), 500e18, owner);

        assertEq(token.balanceOf(owner), 500e18);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_rescueToken_ETH() public {
        address ethSentinel = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

        // Force ETH into the router.
        vm.deal(address(router), 1 ether);

        vm.prank(owner);
        router.rescueToken(ethSentinel, 1 ether, owner);

        assertEq(owner.balance, 1 ether);
        assertEq(address(router).balance, 0);
    }

    function test_rescueToken_onlyOwner() public {
        vm.prank(notOwner);
        vm.expectRevert(rAgg.Unauthorized.selector);
        router.rescueToken(address(token), 100, owner);
    }

    function test_rescueToken_revertsZeroAddress() public {
        token.mint(address(router), 100);

        vm.prank(owner);
        vm.expectRevert(rAgg.ZeroAddress.selector);
        router.rescueToken(address(token), 100, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                          REENTRANCY TESTS
    //////////////////////////////////////////////////////////////*/

    function test_reentrancy_blocked() public {
        // Deploy a malicious bridge that tries to re-enter.
        ReentrantBridge malicious = new ReentrantBridge(router, token);

        vm.prank(owner);
        router.addTarget(address(malicious), bytes26("malicious"), 0x07, 0x03);

        token.mint(user, 2000e18);

        vm.startPrank(user);
        token.approve(address(router), 2000e18);

        bytes memory calldata_ = abi.encodeCall(
            ReentrantBridge.deposit, (address(token), 1000e18, 8453, user)
        );

        // The reentrant call should fail.
        vm.expectRevert();
        router.bridgeERC20(address(malicious), address(token), 1000e18, 8453, calldata_);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                            FUZZ TESTS
    //////////////////////////////////////////////////////////////*/

    function testFuzz_bridgeERC20_anyAmount(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);

        token.mint(user, amount);

        vm.startPrank(user);
        token.approve(address(router), amount);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.deposit, (address(token), amount, 8453, user)
        );

        router.bridgeERC20(address(bridge), address(token), amount, 8453, calldata_);
        vm.stopPrank();

        assertEq(token.balanceOf(address(bridge)), amount);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function testFuzz_bridgeNative_anyAmount(uint256 amount) public {
        amount = bound(amount, 1, 1000 ether);

        vm.deal(user, amount);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.depositETH, (8453, user)
        );

        vm.prank(user);
        router.bridgeNative{value: amount}(address(bridge), 8453, calldata_);

        assertEq(address(bridge).balance, amount);
        assertEq(address(router).balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
                          RECEIVE ETH TEST
    //////////////////////////////////////////////////////////////*/

    function test_receiveETH() public {
        vm.deal(user, 1 ether);
        vm.prank(user);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(router).balance, 1 ether);
    }

    /*//////////////////////////////////////////////////////////////
                       BRIDGE METADATA TESTS
    //////////////////////////////////////////////////////////////*/

    function test_bridgeMeta_readFromConstructor() public view {
        (bytes26 name, uint32 chains, uint16 tokens) = router.bridgeMeta(address(bridge));
        assertEq(name, bytes26("mockbridge"));
        assertEq(chains, 0x07);
        assertEq(tokens, 0x03);
    }

    function test_bridgeMeta_readSecondTarget() public view {
        (bytes26 name, uint32 chains, uint16 tokens) = router.bridgeMeta(address(usdtBridge));
        assertEq(name, bytes26("mockusdt"));
        assertEq(chains, 0x03);
        assertEq(tokens, 0x02);
    }

    function test_getTargets() public view {
        address[] memory targets = router.getTargets();
        assertEq(targets.length, 2);
        assertEq(targets[0], address(bridge));
        assertEq(targets[1], address(usdtBridge));
    }

    function test_getChainIds() public view {
        uint256[] memory ids = router.getChainIds();
        assertEq(ids.length, 3);
        assertEq(ids[0], 1);
        assertEq(ids[1], 8453);
        assertEq(ids[2], 42161);
    }

    function test_getTokenSymbols() public view {
        bytes32[] memory symbols = router.getTokenSymbols();
        assertEq(symbols.length, 2);
        assertEq(symbols[0], bytes32("USDC"));
        assertEq(symbols[1], bytes32("USDT"));
    }

    function test_addTarget_storesMetadata() public {
        address newTarget = address(0x2222);
        vm.prank(owner);
        router.addTarget(newTarget, bytes26("newbridge"), 0x05, 0x01);

        (bytes26 name, uint32 chains, uint16 tokens) = router.bridgeMeta(newTarget);
        assertEq(name, bytes26("newbridge"));
        assertEq(chains, 0x05);
        assertEq(tokens, 0x01);
    }

    function test_addTarget_appendsToTargetList() public {
        address newTarget = address(0x2222);
        vm.prank(owner);
        router.addTarget(newTarget, bytes26("new"), 0x01, 0x01);

        address[] memory targets = router.getTargets();
        assertEq(targets.length, 3);
        assertEq(targets[2], newTarget);
    }

    function test_addTarget_noDuplicateOnReAdd() public {
        // Remove then re-add the bridge.
        vm.startPrank(owner);
        router.removeTarget(address(bridge));
        router.addTarget(address(bridge), bytes26("mockbridge"), 0x07, 0x03);
        vm.stopPrank();

        // Should still have 2 targets, not 3.
        address[] memory targets = router.getTargets();
        assertEq(targets.length, 2);
    }

    function test_addTarget_revertsBitmapOverflow_chains() public {
        // 3 chains in legend, so max valid bitmap is 0x07 (bits 0-2).
        vm.prank(owner);
        vm.expectRevert(rAgg.BitmapOverflow.selector);
        router.addTarget(address(0x3333), bytes26("bad"), 0x08, 0x01); // bit 3 set = overflow
    }

    function test_addTarget_revertsBitmapOverflow_tokens() public {
        // 2 tokens in legend, so max valid bitmap is 0x03 (bits 0-1).
        vm.prank(owner);
        vm.expectRevert(rAgg.BitmapOverflow.selector);
        router.addTarget(address(0x3333), bytes26("bad"), 0x01, 0x04); // bit 2 set = overflow
    }

    function test_addTarget_revertsZeroName() public {
        vm.prank(owner);
        vm.expectRevert(rAgg.InvalidTarget.selector);
        router.addTarget(address(0x3333), bytes26(0), 0x01, 0x01);
    }

    function test_removeTarget_thenReAdd() public {
        vm.prank(owner);
        router.removeTarget(address(bridge));
        assertFalse(router.approvedTargets(address(bridge)));

        vm.prank(owner);
        router.addTarget(address(bridge), bytes26("bridgev2"), 0x03, 0x01);
        assertTrue(router.approvedTargets(address(bridge)));

        (bytes26 name, uint32 chains, uint16 tokens) = router.bridgeMeta(address(bridge));
        assertEq(name, bytes26("bridgev2"));
        assertEq(chains, 0x03);
        assertEq(tokens, 0x01);
    }

    function test_addChainId() public {
        vm.prank(owner);
        router.addChainId(10); // Optimism

        uint256[] memory ids = router.getChainIds();
        assertEq(ids.length, 4);
        assertEq(ids[3], 10);
    }

    function test_addChainId_revertsLegendOverflow() public {
        vm.startPrank(owner);
        for (uint256 i; i < 29; ++i) {
            router.addChainId(10 + i);
        }
        vm.expectRevert(rAgg.BitmapOverflow.selector);
        router.addChainId(999);
        vm.stopPrank();
    }

    function test_setChainId() public {
        vm.prank(owner);
        router.setChainId(1, 999); // Change Base (8453) to HyperEVM (999)

        uint256[] memory ids = router.getChainIds();
        assertEq(ids[1], 999);
    }

    function test_setChainId_revertsOutOfBounds() public {
        vm.prank(owner);
        vm.expectRevert(rAgg.OutOfBounds.selector);
        router.setChainId(99, 1);
    }

    function test_addTokenSymbol() public {
        vm.prank(owner);
        router.addTokenSymbol(bytes32("ETH"));

        bytes32[] memory symbols = router.getTokenSymbols();
        assertEq(symbols.length, 3);
        assertEq(symbols[2], bytes32("ETH"));
    }

    function test_addTokenSymbol_revertsLegendOverflow() public {
        vm.startPrank(owner);
        for (uint256 i; i < 14; ++i) {
            router.addTokenSymbol(bytes32(i + 100));
        }
        vm.expectRevert(rAgg.BitmapOverflow.selector);
        router.addTokenSymbol(bytes32("OVERFLOW"));
        vm.stopPrank();
    }

    function test_setTokenSymbol() public {
        vm.prank(owner);
        router.setTokenSymbol(0, bytes32("DAI"));

        bytes32[] memory symbols = router.getTokenSymbols();
        assertEq(symbols[0], bytes32("DAI"));
    }

    function test_setTokenSymbol_revertsOutOfBounds() public {
        vm.prank(owner);
        vm.expectRevert(rAgg.OutOfBounds.selector);
        router.setTokenSymbol(99, bytes32("X"));
    }

    function test_addChainId_onlyOwner() public {
        vm.prank(notOwner);
        vm.expectRevert(rAgg.Unauthorized.selector);
        router.addChainId(10);
    }

    function test_removeTarget_prunesFromGetTargets() public {
        vm.prank(owner);
        router.removeTarget(address(bridge));

        address[] memory targets = router.getTargets();
        assertEq(targets.length, 1);
        assertEq(targets[0], address(usdtBridge));

        assertFalse(router.approvedTargets(address(bridge)));
    }

    function test_bitmapDecoding_roundtrip() public view {
        // Verify an agent can decode bitmaps using the legends.
        uint256[] memory ids = router.getChainIds();
        bytes32[] memory symbols = router.getTokenSymbols();
        (bytes26 name, uint32 chains, uint16 tokens) = router.bridgeMeta(address(bridge));

        assertEq(name, bytes26("mockbridge"));

        // chains = 0x07 = bits 0,1,2 set → all 3 chains.
        for (uint256 i; i < ids.length; ++i) {
            assertTrue(chains & uint32(1 << i) != 0);
        }

        // tokens = 0x03 = bits 0,1 set → USDC + USDT.
        for (uint256 i; i < symbols.length; ++i) {
            assertTrue(tokens & uint16(1 << i) != 0);
        }
    }

    function testFuzz_bridgeMeta_roundtrip(bytes26 name, uint32 chains, uint16 tokens) public {
        vm.assume(name != 0);
        // Bound bitmaps to valid range for current legends.
        chains = uint32(bound(chains, 0, (1 << chainIdsList.length) - 1));
        tokens = uint16(bound(uint256(tokens), 0, (1 << tokenSymbolsList.length) - 1));

        address target = address(uint160(uint256(keccak256(abi.encode(name, chains, tokens)))));
        vm.assume(target != address(0) && target != address(router));

        vm.prank(owner);
        router.addTarget(target, name, chains, tokens);

        (bytes26 rName, uint32 rChains, uint16 rTokens) = router.bridgeMeta(target);
        assertEq(rName, name);
        assertEq(rChains, chains);
        assertEq(rTokens, tokens);
    }

    /*//////////////////////////////////////////////////////////////
                      BRIDGE ERC20 PERMIT2 TESTS
    //////////////////////////////////////////////////////////////*/

    address constant PERMIT2_ADDR = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function _deployMockPermit2() internal {
        MockPermit2 mock = new MockPermit2();
        vm.etch(PERMIT2_ADDR, address(mock).code);
    }

    function test_bridgeERC20Permit2_basic() public {
        _deployMockPermit2();

        uint256 amount = 1000e18;
        token.mint(user, amount);

        // User approves Permit2 (one-time, like in production).
        vm.prank(user);
        token.approve(PERMIT2_ADDR, type(uint256).max);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.deposit, (address(token), amount, 8453, user)
        );

        vm.expectEmit(true, true, true, true);
        emit rAgg.BridgeInitiated(user, address(bridge), address(token), amount, 8453);

        vm.prank(user);
        router.bridgeERC20Permit2(
            address(bridge), address(token), amount, 8453, calldata_,
            0, block.timestamp + 3600, hex"deadbeef",
            bytes16("which.wei-ui")
        );

        assertEq(token.balanceOf(user), 0);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(bridge)), amount);
    }

    function test_bridgeERC20Permit2_emitsBridgeRef() public {
        _deployMockPermit2();

        uint256 amount = 500e18;
        token.mint(user, amount);

        vm.prank(user);
        token.approve(PERMIT2_ADDR, type(uint256).max);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.deposit, (address(token), amount, 8453, user)
        );

        vm.expectEmit(false, false, false, true);
        emit rAgg.BridgeRef(bytes16("which.wei-ui"));

        vm.prank(user);
        router.bridgeERC20Permit2(
            address(bridge), address(token), amount, 8453, calldata_,
            1, block.timestamp + 3600, hex"aabb",
            bytes16("which.wei-ui")
        );
    }

    function test_bridgeERC20Permit2_noRefEvent_whenZero() public {
        _deployMockPermit2();

        uint256 amount = 100e18;
        token.mint(user, amount);

        vm.prank(user);
        token.approve(PERMIT2_ADDR, type(uint256).max);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.deposit, (address(token), amount, 8453, user)
        );

        // Record logs, verify only BridgeInitiated, no BridgeRef.
        vm.recordLogs();

        vm.prank(user);
        router.bridgeERC20Permit2(
            address(bridge), address(token), amount, 8453, calldata_,
            0, block.timestamp + 3600, hex"cc",
            bytes16(0) // zero ref → no BridgeRef event
        );

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 bridgeRefTopic = keccak256("BridgeRef(bytes16)");
        for (uint256 i; i < logs.length; ++i) {
            assertFalse(logs[i].topics[0] == bridgeRefTopic, "BridgeRef should not be emitted");
        }
    }

    function test_bridgeERC20Permit2_revertsUnapprovedTarget() public {
        _deployMockPermit2();

        vm.expectRevert(rAgg.TargetNotApproved.selector);
        vm.prank(user);
        router.bridgeERC20Permit2(
            address(0x9999), address(token), 100, 8453, "",
            0, block.timestamp + 3600, hex"aa", bytes16(0)
        );
    }

    function test_bridgeERC20Permit2_revertsIfPermit2NotDeployed() public {
        // Don't deploy mock — PERMIT2_ADDR has no code.
        uint256 amount = 100e18;
        token.mint(user, amount);

        vm.prank(user);
        token.approve(address(router), amount);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.deposit, (address(token), amount, 8453, user)
        );

        vm.expectRevert(rAgg.Permit2NotDeployed.selector);
        vm.prank(user);
        router.bridgeERC20Permit2(
            address(bridge), address(token), amount, 8453, calldata_,
            0, block.timestamp + 3600, hex"aa", bytes16(0)
        );
    }

    function test_bridgeERC20Permit2_resetsApproval() public {
        _deployMockPermit2();

        uint256 amount = 1000e18;
        token.mint(user, amount);

        vm.prank(user);
        token.approve(PERMIT2_ADDR, type(uint256).max);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.deposit, (address(token), amount, 8453, user)
        );

        vm.prank(user);
        router.bridgeERC20Permit2(
            address(bridge), address(token), amount, 8453, calldata_,
            0, block.timestamp + 3600, hex"aa", bytes16(0)
        );

        // Router's allowance to bridge should be 0 after tx.
        assertEq(token.allowance(address(router), address(bridge)), 0);
    }

    function test_bridgeERC20Permit2_refundsLeftoverTokens() public {
        _deployMockPermit2();

        uint256 amount = 1000e18;
        uint256 pullAmount = 800e18;
        token.mint(user, amount);

        vm.prank(user);
        token.approve(PERMIT2_ADDR, type(uint256).max);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.depositPartialERC20, (address(token), pullAmount, 8453, user)
        );

        vm.prank(user);
        router.bridgeERC20Permit2(
            address(bridge), address(token), amount, 8453, calldata_,
            0, block.timestamp + 3600, hex"aa", bytes16(0)
        );

        assertEq(token.balanceOf(user), 200e18);
        assertEq(token.balanceOf(address(bridge)), pullAmount);
        assertEq(token.balanceOf(address(router)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                       BRIDGE ERC20 REF TESTS
    //////////////////////////////////////////////////////////////*/

    function test_bridgeERC20Ref_basic() public {
        uint256 amount = 1000e18;
        token.mint(user, amount);

        vm.startPrank(user);
        token.approve(address(router), amount);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.deposit, (address(token), amount, 8453, user)
        );

        vm.expectEmit(true, true, true, true);
        emit rAgg.BridgeInitiated(user, address(bridge), address(token), amount, 8453);
        vm.expectEmit(false, false, false, true);
        emit rAgg.BridgeRef(bytes16("which.wei-agent"));

        router.bridgeERC20Ref(address(bridge), address(token), amount, 8453, calldata_, bytes16("which.wei-agent"));
        vm.stopPrank();

        assertEq(token.balanceOf(user), 0);
        assertEq(token.balanceOf(address(bridge)), amount);
    }

    function test_bridgeERC20Ref_noRefEvent_whenZero() public {
        uint256 amount = 100e18;
        token.mint(user, amount);

        vm.startPrank(user);
        token.approve(address(router), amount);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.deposit, (address(token), amount, 8453, user)
        );

        vm.recordLogs();
        router.bridgeERC20Ref(address(bridge), address(token), amount, 8453, calldata_, bytes16(0));
        vm.stopPrank();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 bridgeRefTopic = keccak256("BridgeRef(bytes16)");
        for (uint256 i; i < logs.length; ++i) {
            assertFalse(logs[i].topics[0] == bridgeRefTopic, "BridgeRef should not be emitted");
        }
    }

    function test_bridgeERC20Ref_revertsOnUnapprovedTarget() public {
        vm.expectRevert(rAgg.TargetNotApproved.selector);
        vm.prank(user);
        router.bridgeERC20Ref(address(0x9999), address(token), 100, 8453, "", bytes16("test"));
    }

    /*//////////////////////////////////////////////////////////////
                       BRIDGE NATIVE REF TESTS
    //////////////////////////////////////////////////////////////*/

    function test_bridgeNativeRef_basic() public {
        uint256 amount = 1 ether;
        vm.deal(user, amount);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.depositETH, (8453, user)
        );

        vm.expectEmit(true, true, true, true);
        emit rAgg.BridgeInitiated(user, address(bridge), 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE, amount, 8453);
        vm.expectEmit(false, false, false, true);
        emit rAgg.BridgeRef(bytes16("which.wei-ui"));

        vm.prank(user);
        router.bridgeNativeRef{value: amount}(address(bridge), 8453, calldata_, bytes16("which.wei-ui"));

        assertEq(address(bridge).balance, amount);
        assertEq(address(router).balance, 0);
    }

    function test_bridgeNativeRef_noRefEvent_whenZero() public {
        uint256 amount = 1 ether;
        vm.deal(user, amount);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.depositETH, (8453, user)
        );

        vm.recordLogs();

        vm.prank(user);
        router.bridgeNativeRef{value: amount}(address(bridge), 8453, calldata_, bytes16(0));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 bridgeRefTopic = keccak256("BridgeRef(bytes16)");
        for (uint256 i; i < logs.length; ++i) {
            assertFalse(logs[i].topics[0] == bridgeRefTopic, "BridgeRef should not be emitted");
        }
    }

    function test_bridgeNativeRef_revertsOnUnapprovedTarget() public {
        vm.deal(user, 1 ether);
        vm.expectRevert(rAgg.TargetNotApproved.selector);
        vm.prank(user);
        router.bridgeNativeRef{value: 1 ether}(address(0x9999), 8453, "", bytes16("test"));
    }

    function test_bridgeNativeRef_refundsExcess() public {
        uint256 sent = 2 ether;
        uint256 needed = 1 ether;
        vm.deal(user, sent);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.depositPartialETH, (8453, user, needed)
        );

        uint256 userBalBefore = user.balance;
        vm.prank(user);
        router.bridgeNativeRef{value: sent}(address(bridge), 8453, calldata_, bytes16("test"));

        assertEq(address(bridge).balance, needed);
        assertEq(user.balance, userBalBefore - needed);
    }

    /*//////////////////////////////////////////////////////////////
                         PERMIT2 FUZZ TESTS
    //////////////////////////////////////////////////////////////*/

    function testFuzz_bridgeERC20Permit2_anyAmount(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);

        _deployMockPermit2();
        token.mint(user, amount);

        vm.prank(user);
        token.approve(PERMIT2_ADDR, type(uint256).max);

        bytes memory calldata_ = abi.encodeCall(
            MockBridge.deposit, (address(token), amount, 8453, user)
        );

        vm.prank(user);
        router.bridgeERC20Permit2(
            address(bridge), address(token), amount, 8453, calldata_,
            42, block.timestamp + 3600, hex"aabb",
            bytes16("which.wei-ui")
        );

        assertEq(token.balanceOf(address(bridge)), amount);
        assertEq(token.balanceOf(address(router)), 0);
    }
}

/*//////////////////////////////////////////////////////////////
                    REENTRANCY ATTACK CONTRACT
//////////////////////////////////////////////////////////////*/

contract ReentrantBridge {
    rAgg immutable router;
    MockERC20 immutable token;

    constructor(rAgg _router, MockERC20 _token) {
        router = _router;
        token = _token;
    }

    function deposit(address, uint256 amount, uint256, address) external {
        // Take the tokens.
        token.transferFrom(msg.sender, address(this), amount);
        // Try to re-enter the router.
        token.approve(address(router), amount);
        bytes memory calldata_ = abi.encodeCall(
            this.deposit, (address(token), amount, 8453, address(this))
        );
        router.bridgeERC20(address(this), address(token), amount, 8453, calldata_);
    }
}
