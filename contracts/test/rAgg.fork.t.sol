// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test, console2} from "forge-std/Test.sol";
import {rAgg} from "../src/rAgg.sol";

/// @dev Interface for LayerZero OFT quoteSend/send functions.
interface IOFT {
    struct SendParam {
        uint32 dstEid;
        bytes32 to;
        uint256 amountLD;
        uint256 minAmountLD;
        bytes extraOptions;
        bytes composeMsg;
        bytes oftCmd;
    }

    struct MessagingFee {
        uint256 nativeFee;
        uint256 lzTokenFee;
    }

    function quoteSend(SendParam calldata _sendParam, bool _payInLzToken) external view returns (MessagingFee memory);
    function send(SendParam calldata _sendParam, MessagingFee calldata _fee, address _refundAddress) external payable;
    function sendToken(SendParam calldata _sendParam, MessagingFee calldata _fee, address _refundAddress) external payable;
}

/// @dev Interface for Mayan Forwarder.
interface IMayanForwarder {
    struct PermitParams {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function forwardERC20(
        address tokenIn,
        uint256 amountIn,
        PermitParams calldata permitParams,
        address mayanProtocol,
        bytes calldata protocolData
    ) external payable;
}

/// @dev Interface for Mayan Swift protocol.
interface IMayanSwift {
    struct OrderParams {
        bytes32 trader;
        bytes32 tokenOut;
        uint64 minAmountOut;
        uint64 gasDrop;
        uint64 cancelFee;
        uint64 refundFee;
        uint64 deadline;
        bytes32 destAddr;
        uint16 destChainId;
        bytes32 referrerAddr;
        uint8 referrerBps;
        uint8 auctionMode;
        bytes32 random;
    }

    function createOrderWithToken(
        address tokenIn,
        uint256 amountIn,
        OrderParams calldata params
    ) external payable returns (bytes32);
}

/// @dev Interface for Eco Portal publishAndFund.
interface IEcoPortal {
    struct TokenAmount {
        address token;
        uint256 amount;
    }

    struct Reward {
        uint64 deadline;
        address creator;
        address prover;
        uint256 nativeAmount;
        TokenAmount[] tokens;
    }

    function publishAndFund(
        uint64 destination,
        bytes calldata route,
        Reward calldata reward,
        bool allowPartial
    ) external payable returns (bytes32, address);
}

/// @title rAgg Fork Tests
/// @notice Tests rAgg against real mainnet bridge contracts via `--fork-url`.
/// @dev Run: forge test --match-path test/rAgg.fork.t.sol --fork-url https://ethereum-rpc.publicnode.com -vvv
contract rAggForkTest is Test {
    /*//////////////////////////////////////////////////////////////
                              CONSTANTS
    //////////////////////////////////////////////////////////////*/

    // -- Tokens --
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant ETH  = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // -- Bridge contracts (Ethereum mainnet) --
    address constant ACROSS_SPOKE_POOL       = 0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;
    address constant CCTP_TOKEN_MESSENGER_V2 = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    address constant CBRIDGE                 = 0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820;
    address constant USDT0_OFT_ADAPTER       = 0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee;
    address constant ECO_PORTAL              = 0x399Dbd5DF04f83103F77A58cBa2B7c4d3cdede97;
    address constant GASZIP_DEPOSIT          = 0x391E7C679d29bD940d63be94AD22A25d25b5A604;
    address constant MAYAN_FORWARDER         = 0x337685fdaB40D39bd02028545a4FfA7D287cC3E2;
    address constant DEBRIDGE_DLN_SOURCE     = 0xeF4fB24aD0916217251F553c0596F8Edc630EB66;
    address constant STARGATE_POOL_USDC      = 0xc026395860Db2d07ee33e05fE50ed7bD583189C7;
    address constant STARGATE_POOL_ETH       = 0x77b2043768d28E9C9aB44E1aBfC95944bcE57931;
    address constant SYNAPSE_CCTP_ROUTER     = 0xd5a597d6e7ddf373a92C8f477DAAA673b0902F48;
    address constant ORBITER_ROUTER          = 0xe530d28960d48708CcF3e62Aa7B42A80bC427Aef;
    address constant RELAY_DEPOSITORY        = 0x4cD00E387622C35bDDB9b4c962C136462338BC31;

    // -- Mayan inner protocol --
    address constant MAYAN_SWIFT             = 0xC38e4e6A15593f908255214653d3D947CA1c2338;

    // -- Chain IDs --
    uint256 constant CID_ETH  = 1;
    uint256 constant CID_BASE = 8453;
    uint256 constant CID_ARB  = 42161;
    uint256 constant CID_OP   = 10;
    uint256 constant CID_POLY = 137;
    uint256 constant CID_BSC  = 56;

    // -- Test amounts --
    uint256 constant USDC_AMOUNT = 100e6;    // 100 USDC
    uint256 constant USDT_AMOUNT = 100e6;    // 100 USDT
    uint256 constant ETH_AMOUNT  = 0.01 ether;

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    rAgg public router;
    address user = makeAddr("user");

    /*//////////////////////////////////////////////////////////////
                                 SETUP
    //////////////////////////////////////////////////////////////*/

    function setUp() public {
        // Chain IDs for bitmap.
        uint256[] memory chainIds = new uint256[](6);
        chainIds[0] = CID_ETH;
        chainIds[1] = CID_BASE;
        chainIds[2] = CID_ARB;
        chainIds[3] = CID_OP;
        chainIds[4] = CID_POLY;
        chainIds[5] = CID_BSC;

        // Token symbols for bitmap.
        bytes32[] memory tokenSymbols = new bytes32[](3);
        tokenSymbols[0] = bytes32("USDC");
        tokenSymbols[1] = bytes32("USDT");
        tokenSymbols[2] = bytes32("ETH");

        // Pre-populate all bridge targets.
        address[] memory targets = new address[](13);
        targets[0]  = ACROSS_SPOKE_POOL;
        targets[1]  = CCTP_TOKEN_MESSENGER_V2;
        targets[2]  = CBRIDGE;
        targets[3]  = USDT0_OFT_ADAPTER;
        targets[4]  = ECO_PORTAL;
        targets[5]  = GASZIP_DEPOSIT;
        targets[6]  = MAYAN_FORWARDER;
        targets[7]  = DEBRIDGE_DLN_SOURCE;
        targets[8]  = STARGATE_POOL_USDC;
        targets[9]  = STARGATE_POOL_ETH;
        targets[10] = SYNAPSE_CCTP_ROUTER;
        targets[11] = ORBITER_ROUTER;
        targets[12] = RELAY_DEPOSITORY;

        bytes26[] memory names = new bytes26[](13);
        names[0]  = bytes26("across");
        names[1]  = bytes26("cctp");
        names[2]  = bytes26("cbridge");
        names[3]  = bytes26("usdt0");
        names[4]  = bytes26("eco");
        names[5]  = bytes26("gaszip");
        names[6]  = bytes26("mayan");
        names[7]  = bytes26("debridge");
        names[8]  = bytes26("stargate-usdc");
        names[9]  = bytes26("stargate-eth");
        names[10] = bytes26("synapse");
        names[11] = bytes26("orbiter");
        names[12] = bytes26("relay");

        // All chains, all tokens (bitmap = all bits set within range).
        uint32 allChains = uint32((1 << 6) - 1); // 0x3F = bits 0-5
        uint16 allTokens = uint16((1 << 3) - 1); // 0x07 = bits 0-2

        uint32[] memory chains = new uint32[](13);
        uint16[] memory tokens = new uint16[](13);
        for (uint256 i; i < 13; i++) {
            chains[i] = allChains;
            tokens[i] = allTokens;
        }

        router = new rAgg(
            address(this),
            chainIds,
            tokenSymbols,
            targets,
            names,
            chains,
            tokens
        );

        // Fund user with tokens and ETH.
        deal(USDC, user, 10_000e6);
        deal(USDT, user, 10_000e6);
        deal(user, 100 ether);
    }

    /// @dev Helper: user approves router for a token.
    function _approveRouter(address token, uint256 amount) internal {
        vm.prank(user);
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", address(router), amount));
        assertTrue(ok, "approve failed");
    }

    /*//////////////////////////////////////////////////////////////
                            1. ACROSS
    //////////////////////////////////////////////////////////////*/

    /// @notice Test bridging USDC via Across SpokePool.depositV3 through rAgg.
    function test_fork_across_bridgeUSDC() public {
        _approveRouter(USDC, USDC_AMOUNT);

        // Build depositV3 calldata.
        // depositV3(depositor, recipient, inputToken, outputToken, inputAmount, outputAmount,
        //           destinationChainId, exclusiveRelayer, quoteTimestamp, fillDeadline,
        //           exclusivityDeadline, message)
        bytes memory bridgeCalldata = abi.encodeWithSignature(
            "depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)",
            address(router),     // depositor = router (since router is msg.sender to SpokePool)
            user,                // recipient on dest chain
            USDC,                // inputToken
            USDC,                // outputToken (same-token bridge)
            USDC_AMOUNT,         // inputAmount
            USDC_AMOUNT * 99 / 100, // outputAmount (1% slippage)
            CID_BASE,            // destinationChainId
            address(0),          // exclusiveRelayer (none)
            uint32(block.timestamp), // quoteTimestamp
            uint32(block.timestamp + 3600), // fillDeadline (1hr)
            0,                   // exclusivityDeadline
            ""                   // message (empty)
        );

        vm.prank(user);
        router.bridgeERC20(ACROSS_SPOKE_POOL, USDC, USDC_AMOUNT, CID_BASE, bridgeCalldata);

        // Verify: user's USDC was pulled.
        uint256 userBalance = _balanceOf(USDC, user);
        assertEq(userBalance, 10_000e6 - USDC_AMOUNT, "user USDC not pulled");

        // Verify: router has no leftover.
        assertEq(_balanceOf(USDC, address(router)), 0, "router has leftover USDC");
    }

    /// @notice Test bridging native ETH via Across SpokePool through rAgg.
    /// @dev Across accepts native ETH and wraps to WETH internally.
    function test_fork_across_bridgeETH() public {
        bytes memory bridgeCalldata = abi.encodeWithSignature(
            "depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)",
            address(router),     // depositor  
            user,                // recipient
            WETH,                // inputToken (WETH — SpokePool wraps ETH→WETH)
            WETH,                // outputToken
            ETH_AMOUNT,          // inputAmount
            ETH_AMOUNT * 99 / 100, // outputAmount
            CID_BASE,            // destinationChainId
            address(0),          // exclusiveRelayer
            uint32(block.timestamp),
            uint32(block.timestamp + 3600),
            0,
            ""
        );

        vm.prank(user);
        router.bridgeNative{value: ETH_AMOUNT}(ACROSS_SPOKE_POOL, CID_BASE, bridgeCalldata);

        // Router should have no leftover ETH.
        assertEq(address(router).balance, 0, "router has leftover ETH");
    }

    /*//////////////////////////////////////////////////////////////
                        2. CCTP (depositForBurn)
    //////////////////////////////////////////////////////////////*/

    /// @notice Test bridging USDC via CCTP TokenMessengerV2.depositForBurn through rAgg.
    function test_fork_cctp_bridgeUSDC() public {
        _approveRouter(USDC, USDC_AMOUNT);

        // CCTP domain for Base = 6.
        uint32 destDomain = 6;
        // Recipient padded to bytes32.
        bytes32 mintRecipient = bytes32(uint256(uint160(user)));

        bytes memory bridgeCalldata = abi.encodeWithSignature(
            "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
            USDC_AMOUNT,         // amount
            destDomain,          // destinationDomain (Base = 6)
            mintRecipient,       // mintRecipient
            USDC,                // burnToken
            bytes32(0),          // destinationCaller (any)
            0,                   // maxFee
            0                    // minFinalityThreshold (0 = standard)
        );

        vm.prank(user);
        router.bridgeERC20(CCTP_TOKEN_MESSENGER_V2, USDC, USDC_AMOUNT, CID_BASE, bridgeCalldata);

        assertEq(_balanceOf(USDC, user), 10_000e6 - USDC_AMOUNT, "user USDC not pulled");
        assertEq(_balanceOf(USDC, address(router)), 0, "router has leftover USDC");
    }

    /*//////////////////////////////////////////////////////////////
                           3. CBRIDGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Test bridging USDC via cBridge.send through rAgg.
    function test_fork_cbridge_bridgeUSDC() public {
        _approveRouter(USDC, USDC_AMOUNT);

        // cBridge send(receiver, token, amount, dstChainId, nonce, maxSlippage)
        bytes memory bridgeCalldata = abi.encodeWithSignature(
            "send(address,address,uint256,uint64,uint64,uint32)",
            user,                // receiver
            USDC,                // token
            USDC_AMOUNT,         // amount
            uint64(CID_BSC),     // dstChainId
            uint64(block.timestamp), // nonce
            uint32(5000)         // maxSlippage (0.5% = 5000 / 1e6)
        );

        vm.prank(user);
        router.bridgeERC20(CBRIDGE, USDC, USDC_AMOUNT, CID_BSC, bridgeCalldata);

        assertEq(_balanceOf(USDC, user), 10_000e6 - USDC_AMOUNT, "user USDC not pulled");
        assertEq(_balanceOf(USDC, address(router)), 0, "router has leftover USDC");
    }

    /*//////////////////////////////////////////////////////////////
                           4. USDT0 (LayerZero OFT)
    //////////////////////////////////////////////////////////////*/

    /// @notice Test bridging USDT via USDT0 OFT Adapter through rAgg.
    /// @dev USDT0 uses LayerZero. We call quoteSend to get the LZ fee, then send().
    function test_fork_usdt0_bridgeUSDT() public {
        _approveRouter(USDT, USDT_AMOUNT);

        // LayerZero endpoint ID for Arbitrum = 30110.
        IOFT.SendParam memory sendParam = IOFT.SendParam({
            dstEid: 30110,
            to: bytes32(uint256(uint160(user))),
            amountLD: USDT_AMOUNT,
            minAmountLD: USDT_AMOUNT * 99 / 100,
            extraOptions: "",
            composeMsg: "",
            oftCmd: ""
        });

        // Query LZ messaging fee.
        IOFT.MessagingFee memory fee = IOFT(USDT0_OFT_ADAPTER).quoteSend(sendParam, false);

        // Build send() calldata using the interface encoder.
        bytes memory bridgeCalldata = abi.encodeCall(
            IOFT.send,
            (sendParam, fee, user)
        );

        vm.prank(user);
        router.bridgeERC20{value: fee.nativeFee}(
            USDT0_OFT_ADAPTER, USDT, USDT_AMOUNT, CID_ARB, bridgeCalldata
        );

        assertEq(_balanceOf(USDT, user), 10_000e6 - USDT_AMOUNT, "user USDT not pulled");
        assertEq(_balanceOf(USDT, address(router)), 0, "router has leftover USDT");
    }

    /*//////////////////////////////////////////////////////////////
                         5. GAS.ZIP (native ETH)
    //////////////////////////////////////////////////////////////*/

    /// @notice Test sending ETH via Gas.zip deposit through rAgg.
    /// @dev Gas.zip's deposit address is a simple receiver. Calldata is normally API-provided.
    function test_fork_gaszip_bridgeETH() public {
        bytes memory bridgeCalldata = abi.encodePacked(
            uint16(1),           // 1 destination
            uint16(8453),        // Base chain ID
            user                 // recipient on dest chain
        );

        vm.prank(user);
        router.bridgeNative{value: ETH_AMOUNT}(GASZIP_DEPOSIT, CID_BASE, bridgeCalldata);
        assertEq(address(router).balance, 0, "router has leftover ETH");
    }

    /*//////////////////////////////////////////////////////////////
                     6. STARGATE (USDC via sendToken)
    //////////////////////////////////////////////////////////////*/

    /// @notice Test bridging USDC via Stargate V2 pool through rAgg.
    /// @dev Stargate pools implement the OFT sendToken interface (same struct layout as USDT0).
    function test_fork_stargate_bridgeUSDC() public {
        _approveRouter(USDC, USDC_AMOUNT);

        // Stargate USDC pool uses same OFT interface. Base dstEid = 30184.
        IOFT.SendParam memory sendParam = IOFT.SendParam({
            dstEid: 30184,       // Base
            to: bytes32(uint256(uint160(user))),
            amountLD: USDC_AMOUNT,
            minAmountLD: USDC_AMOUNT * 99 / 100,
            extraOptions: "",
            composeMsg: "",
            oftCmd: ""           // empty = taxi mode
        });

        // Query LZ fee.
        IOFT.MessagingFee memory fee = IOFT(STARGATE_POOL_USDC).quoteSend(sendParam, false);

        // Stargate pool function is `sendToken` (not OFT `send`).
        bytes memory bridgeCalldata = abi.encodeCall(
            IOFT.sendToken,
            (sendParam, fee, user)
        );

        vm.prank(user);
        router.bridgeERC20{value: fee.nativeFee}(
            STARGATE_POOL_USDC, USDC, USDC_AMOUNT, CID_BASE, bridgeCalldata
        );

        assertEq(_balanceOf(USDC, user), 10_000e6 - USDC_AMOUNT, "user USDC not pulled");
        assertEq(_balanceOf(USDC, address(router)), 0, "router has leftover USDC");
    }

    /// @notice Test bridging native ETH via Stargate ETH pool through rAgg.
    function test_fork_stargate_bridgeETH() public {
        IOFT.SendParam memory sendParam = IOFT.SendParam({
            dstEid: 30184,       // Base
            to: bytes32(uint256(uint160(user))),
            amountLD: ETH_AMOUNT,
            minAmountLD: ETH_AMOUNT * 99 / 100,
            extraOptions: "",
            composeMsg: "",
            oftCmd: ""           // taxi mode
        });

        IOFT.MessagingFee memory fee = IOFT(STARGATE_POOL_ETH).quoteSend(sendParam, false);

        bytes memory bridgeCalldata = abi.encodeCall(
            IOFT.send,
            (sendParam, fee, user)
        );

        vm.prank(user);
        router.bridgeNative{value: ETH_AMOUNT + fee.nativeFee}(
            STARGATE_POOL_ETH, CID_BASE, bridgeCalldata
        );

        assertEq(address(router).balance, 0, "router has leftover ETH");
    }

    /*//////////////////////////////////////////////////////////////
                    7. MAYAN (Swift via Forwarder)
    //////////////////////////////////////////////////////////////*/

    /// @notice Test bridging USDC via Mayan Forwarder → Swift createOrderWithToken through rAgg.
    /// @dev Two-layer calldata: forwardERC20 wraps inner Swift createOrderWithToken call.
    function test_fork_mayan_bridgeUSDC() public {
        _approveRouter(USDC, USDC_AMOUNT);

        // Build inner Swift order params.
        // Wormhole chain ID for Arbitrum = 23.
        // USDC on Arbitrum = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831
        IMayanSwift.OrderParams memory orderParams = IMayanSwift.OrderParams({
            trader: bytes32(uint256(uint160(user))),
            tokenOut: bytes32(uint256(uint160(0xaf88d065e77c8cC2239327C5EDb3A432268e5831))),
            minAmountOut: uint64(USDC_AMOUNT * 99 / 100),
            gasDrop: 0,
            cancelFee: uint64(USDC_AMOUNT / 200),  // 0.5%
            refundFee: uint64(USDC_AMOUNT / 200),
            deadline: uint64(block.timestamp + 3600),
            destAddr: bytes32(uint256(uint160(user))),
            destChainId: 23,     // Wormhole Arbitrum
            referrerAddr: bytes32(0),
            referrerBps: 0,
            auctionMode: 1,
            random: keccak256("test_mayan_random")
        });

        // Inner calldata: Swift.createOrderWithToken(token, amount, params)
        bytes memory innerCalldata = abi.encodeCall(
            IMayanSwift.createOrderWithToken,
            (USDC, USDC_AMOUNT, orderParams)
        );

        // Outer calldata: forwarder.forwardERC20(token, amount, emptyPermit, swift, innerCalldata)
        IMayanForwarder.PermitParams memory emptyPermit;
        bytes memory bridgeCalldata = abi.encodeCall(
            IMayanForwarder.forwardERC20,
            (USDC, USDC_AMOUNT, emptyPermit, MAYAN_SWIFT, innerCalldata)
        );

        vm.prank(user);
        router.bridgeERC20(
            MAYAN_FORWARDER, USDC, USDC_AMOUNT, CID_ARB, bridgeCalldata
        );

        assertEq(_balanceOf(USDC, user), 10_000e6 - USDC_AMOUNT, "user USDC not pulled");
        assertEq(_balanceOf(USDC, address(router)), 0, "router has leftover USDC");
    }

    /*//////////////////////////////////////////////////////////////
                    API-FIXTURE PROVIDERS (8-12)
    //////////////////////////////////////////////////////////////*/

    // The following providers use API-generated fixture calldata.
    // Regenerate fixtures: `npx tsx scripts/generate_fork_fixtures.ts`
    // Fixtures may expire (bridge calldata contains deadlines/nonces).

    /// @notice Test bridging USDC via deBridge DlnSource through rAgg.
    function test_fork_debridge_bridgeUSDC() public {
        _approveRouter(USDC, USDC_AMOUNT);

        string memory json = vm.readFile("test/fixtures/debridge.json");
        address target = vm.parseJsonAddress(json, ".target");
        bytes memory data = vm.parseJsonBytes(json, ".calldata");
        uint256 value = vm.parseJsonUint(json, ".value");

        vm.prank(user);
        router.bridgeERC20{value: value}(target, USDC, USDC_AMOUNT, CID_ARB, data);

        assertEq(_balanceOf(USDC, user), 10_000e6 - USDC_AMOUNT, "user USDC not pulled");
        assertEq(_balanceOf(USDC, address(router)), 0, "router has leftover USDC");
    }

    /// @notice Test bridging USDC via Synapse SynapseBridge through rAgg.
    /// @dev Synapse may return a different router than the pre-configured CCTP router.
    ///      The SynapseBridge module uses internal pool scaling, so the calldata amount
    ///      may differ from input. We extract the actual amount from the bridge calldata.
    function test_fork_synapse_bridgeUSDC() public {
        string memory json = vm.readFile("test/fixtures/synapse.json");
        address target = vm.parseJsonAddress(json, ".target");
        bytes memory data = vm.parseJsonBytes(json, ".calldata");
        uint256 value = vm.parseJsonUint(json, ".value");
        uint256 generatedAt = vm.parseJsonUint(json, ".generatedAt");

        // Warp to fixture generation time (Synapse calldata has tight deadlines).
        vm.warp(generatedAt);

        // Synapse's bridge(to, chainId, token, amount, ...) has amount at calldata offset 100
        // (4 selector + 32 to + 32 chainId + 32 token = 100). Extract the actual bridged amount.
        uint256 bridgeAmount;
        assembly {
            bridgeAmount := mload(add(data, 132)) // 32 (bytes len) + 4 + 96
        }

        // Deal user enough USDC for the bridge amount.
        deal(USDC, user, bridgeAmount);
        _approveRouter(USDC, bridgeAmount);

        // Synapse may return a different router — register it dynamically.
        (bytes26 name,,) = router.bridgeMeta(target);
        if (name == 0) {
            uint32 allChains = uint32((1 << 6) - 1);
            uint16 allTokens = uint16((1 << 3) - 1);
            router.addTarget(target, bytes26("synapse-bridge"), allChains, allTokens);
        }

        vm.prank(user);
        router.bridgeERC20{value: value}(target, USDC, bridgeAmount, CID_ARB, data);

        assertEq(_balanceOf(USDC, address(router)), 0, "router has leftover USDC");
    }

    /// @notice Test bridging USDC via Orbiter Router through rAgg.
    function test_fork_orbiter_bridgeUSDC() public {
        _approveRouter(USDC, USDC_AMOUNT);

        string memory json = vm.readFile("test/fixtures/orbiter.json");
        address target = vm.parseJsonAddress(json, ".target");
        bytes memory data = vm.parseJsonBytes(json, ".calldata");
        uint256 value = vm.parseJsonUint(json, ".value");

        vm.prank(user);
        router.bridgeERC20{value: value}(target, USDC, USDC_AMOUNT, CID_ARB, data);

        assertEq(_balanceOf(USDC, user), 10_000e6 - USDC_AMOUNT, "user USDC not pulled");
        assertEq(_balanceOf(USDC, address(router)), 0, "router has leftover USDC");
    }

    /// @notice Test bridging USDC via Relay Depository through rAgg.
    function test_fork_relay_bridgeUSDC() public {
        _approveRouter(USDC, USDC_AMOUNT);

        string memory json = vm.readFile("test/fixtures/relay.json");
        address target = vm.parseJsonAddress(json, ".target");
        bytes memory data = vm.parseJsonBytes(json, ".calldata");
        uint256 value = vm.parseJsonUint(json, ".value");

        vm.prank(user);
        router.bridgeERC20{value: value}(target, USDC, USDC_AMOUNT, CID_ARB, data);

        assertEq(_balanceOf(USDC, user), 10_000e6 - USDC_AMOUNT, "user USDC not pulled");
        assertEq(_balanceOf(USDC, address(router)), 0, "router has leftover USDC");
    }

    /// @notice Test bridging USDC via Eco Portal publishAndFund through rAgg.
    /// @dev Calldata is built in Solidity from API-provided encodedRoute + contract addresses.
    function test_fork_eco_bridgeUSDC() public {
        _approveRouter(USDC, USDC_AMOUNT);

        string memory json = vm.readFile("test/fixtures/eco.json");
        address prover = vm.parseJsonAddress(json, ".prover");
        uint256 deadline = vm.parseJsonUint(json, ".deadline");
        bytes memory encodedRoute = vm.parseJsonBytes(json, ".encodedRoute");

        // Strip the first 32 bytes (ABI offset) from encodedRoute to get raw route bytes.
        bytes memory routeBytes;
        assembly {
            let len := sub(mload(encodedRoute), 32)
            routeBytes := mload(0x40)
            mstore(routeBytes, len)
            let src := add(encodedRoute, 64) // skip length word + 32-byte offset
            let dst := add(routeBytes, 32)
            for { let i := 0 } lt(i, len) { i := add(i, 32) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
            mstore(0x40, add(dst, len))
        }

        // Build Reward struct.
        IEcoPortal.TokenAmount[] memory rewardTokens = new IEcoPortal.TokenAmount[](1);
        rewardTokens[0] = IEcoPortal.TokenAmount(USDC, USDC_AMOUNT);

        IEcoPortal.Reward memory reward = IEcoPortal.Reward({
            deadline: uint64(deadline),
            creator: address(router), // creator = router (msg.sender to portal)
            prover: prover,
            nativeAmount: 0,
            tokens: rewardTokens
        });

        bytes memory data = abi.encodeCall(
            IEcoPortal.publishAndFund,
            (uint64(CID_ARB), routeBytes, reward, false)
        );

        vm.prank(user);
        router.bridgeERC20(ECO_PORTAL, USDC, USDC_AMOUNT, CID_ARB, data);

        assertEq(_balanceOf(USDC, user), 10_000e6 - USDC_AMOUNT, "user USDC not pulled");
        assertEq(_balanceOf(USDC, address(router)), 0, "router has leftover USDC");
    }

    /*//////////////////////////////////////////////////////////////
                   HELPERS
    //////////////////////////////////////////////////////////////*/

    function _balanceOf(address token, address account) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("balanceOf(address)", account)
        );
        require(ok, "balanceOf failed");
        return abi.decode(data, (uint256));
    }

    /*//////////////////////////////////////////////////////////////
                   PERMIT2 FORK TESTS
    //////////////////////////////////////////////////////////////*/

    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 constant PERMIT2_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,uint256 chainId,address verifyingContract)"
    );

    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256(
        "TokenPermissions(address token,uint256 amount)"
    );

    bytes32 constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    function _permit2DomainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(
            PERMIT2_DOMAIN_TYPEHASH,
            keccak256("Permit2"),
            block.chainid,
            PERMIT2
        ));
    }

    function _signPermit2(
        uint256 signerKey,
        address token,
        uint256 amount,
        address spender,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory signature) {
        bytes32 tokenPermissionsHash = keccak256(abi.encode(
            TOKEN_PERMISSIONS_TYPEHASH,
            token,
            amount
        ));

        bytes32 structHash = keccak256(abi.encode(
            PERMIT_TRANSFER_FROM_TYPEHASH,
            tokenPermissionsHash,
            spender,
            nonce,
            deadline
        ));

        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            _permit2DomainSeparator(),
            structHash
        ));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    /// @notice Test bridging USDC via Permit2 path through Across.
    function test_fork_permit2_across_bridgeUSDC() public {
        // Use a keyed wallet so we can sign the EIP-712 permit.
        (address signer, uint256 signerKey) = makeAddrAndKey("permit2user");
        deal(USDC, signer, 10_000e6);

        // Step 1: Approve Permit2 for USDC (one-time, max approval).
        vm.prank(signer);
        (bool ok,) = USDC.call(abi.encodeWithSignature(
            "approve(address,uint256)", PERMIT2, type(uint256).max
        ));
        assertTrue(ok, "permit2 approve failed");

        // Step 2: Sign the Permit2 transfer.
        uint256 nonce = 0;
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _signPermit2(signerKey, USDC, USDC_AMOUNT, address(router), nonce, deadline);

        // Step 3: Build Across bridge calldata (same as regular test).
        bytes memory bridgeCalldata = abi.encodeWithSignature(
            "depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)",
            address(router), signer, USDC, USDC, USDC_AMOUNT,
            USDC_AMOUNT * 99 / 100, CID_BASE, address(0),
            uint32(block.timestamp), uint32(block.timestamp + 3600), 0, ""
        );

        // Step 4: Bridge via Permit2 — single tx, no prior rAgg approval.
        vm.prank(signer);
        router.bridgeERC20Permit2(
            ACROSS_SPOKE_POOL, USDC, USDC_AMOUNT, CID_BASE, bridgeCalldata,
            nonce, deadline, sig, bytes16("which.wei-ui")
        );

        assertEq(_balanceOf(USDC, signer), 10_000e6 - USDC_AMOUNT, "signer USDC not pulled");
        assertEq(_balanceOf(USDC, address(router)), 0, "router has leftover USDC");
    }

    /// @notice Test Permit2 bridgeERC20Ref with Across (classic approve + ref tag).
    function test_fork_ref_across_bridgeUSDC() public {
        _approveRouter(USDC, USDC_AMOUNT);

        bytes memory bridgeCalldata = abi.encodeWithSignature(
            "depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)",
            address(router), user, USDC, USDC, USDC_AMOUNT,
            USDC_AMOUNT * 99 / 100, CID_BASE, address(0),
            uint32(block.timestamp), uint32(block.timestamp + 3600), 0, ""
        );

        vm.expectEmit(true, true, true, true);
        emit rAgg.BridgeInitiated(user, ACROSS_SPOKE_POOL, USDC, USDC_AMOUNT, CID_BASE);
        vm.expectEmit(false, false, false, true);
        emit rAgg.BridgeRef(bytes16("which.wei-ui"));

        vm.prank(user);
        router.bridgeERC20Ref(ACROSS_SPOKE_POOL, USDC, USDC_AMOUNT, CID_BASE, bridgeCalldata, bytes16("which.wei-ui"));

        assertEq(_balanceOf(USDC, user), 10_000e6 - USDC_AMOUNT, "user USDC not pulled");
        assertEq(_balanceOf(USDC, address(router)), 0, "router has leftover USDC");
    }

    /// @notice Test bridgeNativeRef with Across (native ETH + ref tag).
    function test_fork_ref_across_bridgeETH() public {
        bytes memory bridgeCalldata = abi.encodeWithSignature(
            "depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)",
            address(router), user, WETH, WETH, ETH_AMOUNT,
            ETH_AMOUNT * 99 / 100, CID_BASE, address(0),
            uint32(block.timestamp), uint32(block.timestamp + 3600), 0, ""
        );

        vm.expectEmit(true, true, true, true);
        emit rAgg.BridgeInitiated(user, ACROSS_SPOKE_POOL, ETH, ETH_AMOUNT, CID_BASE);
        vm.expectEmit(false, false, false, true);
        emit rAgg.BridgeRef(bytes16("which.wei-agt"));

        vm.prank(user);
        router.bridgeNativeRef{value: ETH_AMOUNT}(ACROSS_SPOKE_POOL, CID_BASE, bridgeCalldata, bytes16("which.wei-agt"));

        assertEq(address(router).balance, 0, "router has leftover ETH");
    }

    /// @notice Test Permit2 + USDT (non-standard token with approve-to-zero requirement).
    function test_fork_permit2_across_bridgeUSDT() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("permit2usdt");
        deal(USDT, signer, 10_000e6);

        // Approve Permit2 for USDT — USDT requires approve(0) first if nonzero.
        vm.startPrank(signer);
        (bool ok1,) = USDT.call(abi.encodeWithSignature(
            "approve(address,uint256)", PERMIT2, type(uint256).max
        ));
        assertTrue(ok1, "permit2 approve USDT failed");
        vm.stopPrank();

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _signPermit2(signerKey, USDT, USDT_AMOUNT, address(router), nonce, deadline);

        bytes memory bridgeCalldata = abi.encodeWithSignature(
            "depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)",
            address(router), signer, USDT, USDT, USDT_AMOUNT,
            USDT_AMOUNT * 99 / 100, CID_BASE, address(0),
            uint32(block.timestamp), uint32(block.timestamp + 3600), 0, ""
        );

        vm.prank(signer);
        router.bridgeERC20Permit2(
            ACROSS_SPOKE_POOL, USDT, USDT_AMOUNT, CID_BASE, bridgeCalldata,
            nonce, deadline, sig, bytes16("which.wei-ui")
        );

        assertEq(_balanceOf(USDT, signer), 10_000e6 - USDT_AMOUNT, "signer USDT not pulled");
        assertEq(_balanceOf(USDT, address(router)), 0, "router has leftover USDT");
    }
}
