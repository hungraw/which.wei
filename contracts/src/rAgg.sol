// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Minimal Permit2 SignatureTransfer interface.
interface IPermit2 {
    struct TokenPermissions { address token; uint256 amount; }
    struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }
    struct SignatureTransferDetails { address to; uint256 requestedAmount; }
    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

/// @title rAgg — Minimalist bridge aggregator router
/// @author rawxbt (https://which.wei.limo)
/// @notice Routes token bridge calls through pre-approved bridge targets.
///         Supports ERC20 (incl. USDT) and native ETH bridging with automatic
///         leftover refunds. Admin manages approved targets, chain IDs, and token symbols.
contract rAgg {
    /*//////////////////////////////////////////////////////////////
                              OWNERSHIP
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted when contract ownership is transferred.
    /// @param from Previous owner address.
    /// @param to New owner address.
    event OwnershipTransferred(address indexed from, address indexed to);

    error Unauthorized();

    /// @notice Current contract owner.
    address public owner;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    /// @notice Transfer ownership to a new address. Only callable by current owner.
    /// @param _owner New owner address (must not be zero).
    function transferOwnership(address _owner) public payable onlyOwner {
        if (_owner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, owner = _owner);
    }

    /*//////////////////////////////////////////////////////////////
                          TRANSIENT REENTRANCY
    //////////////////////////////////////////////////////////////*/

    error Reentrancy();

    modifier nonReentrant() {
        /// @solidity memory-safe-assembly
        assembly {
            if tload(0) {
                mstore(0x00, 0xab143c06) // Reentrancy()
                revert(0x1c, 0x04)
            }
            tstore(0, 1)
        }
        _;
        /// @solidity memory-safe-assembly
        assembly {
            tstore(0, 0)
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error TargetNotApproved();
    error ZeroAddress();
    error InvalidTarget();
    error BitmapOverflow();
    error OutOfBounds();
    error Permit2NotDeployed();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted after a successful bridge call.
    /// @param user The msg.sender who initiated the bridge.
    /// @param target The bridge contract that was called.
    /// @param token The token address bridged (ETH sentinel for native).
    /// @param amount Amount of tokens bridged.
    /// @param destChainId Destination chain ID.
    event BridgeInitiated(
        address indexed user,
        address indexed target,
        address indexed token,
        uint256 amount,
        uint256 destChainId
    );

    /// @notice Emitted when a new bridge target is approved.
    /// @param target Bridge contract address.
    /// @param name Provider name (right-padded, max 26 chars).
    /// @param chains Bitmap of supported chain IDs.
    /// @param tokens Bitmap of supported token symbols.
    event TargetAdded(address indexed target, bytes26 name, uint32 chains, uint16 tokens);

    /// @notice Emitted when a bridge target is removed.
    /// @param target Bridge contract address.
    event TargetRemoved(address indexed target);

    /// @notice Emitted alongside BridgeInitiated to tag the bridge source.
    /// @param ref Source identifier (e.g. "which.wei-ui", "which.wei-agent").
    event BridgeRef(bytes16 ref);

    /// @notice Emitted when stuck tokens are rescued by the owner.
    /// @param token Token address rescued (ETH sentinel for native).
    /// @param amount Amount rescued.
    /// @param to Recipient address.
    event Rescued(address indexed token, uint256 amount, address indexed to);

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    uint256 internal constant MAX_CHAIN_BITS = 32;
    uint256 internal constant MAX_TOKEN_BITS = 16;

    address internal constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @dev Canonical Permit2 address (same on all chains where deployed).
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @dev 1 slot: name(26) | chains(4) | tokens(2). name≠0 ⇒ approved.
    struct BridgeMeta {
        bytes26 name;             // Provider name, right-padded. Max 26 chars.
        uint32  supportedChains;  // Bitmap: bit index → chainIds[index].
        uint16  supportedTokens;  // Bitmap: bit index → tokenSymbols[index].
    }

    mapping(address => BridgeMeta) public bridgeMeta;

    address[] internal targetList;
    mapping(address => uint256) internal targetIndexPlusOne;

    uint256[] internal chainIds;
    bytes32[] internal tokenSymbols;

    /// @notice Check if a target address is an approved bridge.
    /// @param target The address to check.
    /// @return True if the target has a non-zero name (i.e. is approved).
    function approvedTargets(address target) public view returns (bool) {
        return bridgeMeta[target].name != 0;
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address _owner,
        uint256[] memory _chainIds,
        bytes32[] memory _tokenSymbols,
        address[] memory _targets,
        bytes26[] memory _names,
        uint32[] memory _chains,
        uint16[] memory _tokens
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        if (
            _targets.length != _names.length
                || _targets.length != _chains.length
                || _targets.length != _tokens.length
        ) revert InvalidTarget();
        if (_chainIds.length > MAX_CHAIN_BITS || _tokenSymbols.length > MAX_TOKEN_BITS) {
            revert BitmapOverflow();
        }

        emit OwnershipTransferred(address(0), owner = _owner);

        chainIds = _chainIds;
        tokenSymbols = _tokenSymbols;

        uint256 maxChains = 1 << _chainIds.length;
        uint256 maxTokens = 1 << _tokenSymbols.length;

        for (uint256 i; i < _targets.length;) {
            if (_targets[i] == address(0) || _targets[i] == address(this)) revert InvalidTarget();
            if (_names[i] == 0) revert InvalidTarget();
            if (_chains[i] >= maxChains) revert BitmapOverflow();
            if (_tokens[i] >= maxTokens) revert BitmapOverflow();
            bridgeMeta[_targets[i]] = BridgeMeta(_names[i], _chains[i], _tokens[i]);
            if (targetIndexPlusOne[_targets[i]] == 0) {
                targetList.push(_targets[i]);
                targetIndexPlusOne[_targets[i]] = targetList.length;
            }
            emit TargetAdded(_targets[i], _names[i], _chains[i], _tokens[i]);
            unchecked { ++i; }
        }
    }

    /*//////////////////////////////////////////////////////////////
                               RECEIVE
    //////////////////////////////////////////////////////////////*/

    /// @notice Accept ETH sent directly (e.g. refunds from bridge contracts).
    receive() external payable {}

    /*//////////////////////////////////////////////////////////////
                                 BRIDGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Bridge ERC20 tokens through an approved target.
    /// @dev Pulls tokens from sender, approves target, forwards calldata, clears approval, refunds leftovers.
    /// @param target Approved bridge contract to call.
    /// @param token ERC20 token to bridge.
    /// @param amount Amount to pull from sender and approve.
    /// @param destChainId Destination chain (logged in event, not validated on-chain).
    /// @param bridgeCalldata Raw calldata to forward to the bridge contract.
    function bridgeERC20(
        address target,
        address token,
        uint256 amount,
        uint256 destChainId,
        bytes calldata bridgeCalldata
    ) external payable nonReentrant {
        if (bridgeMeta[target].name == 0) revert TargetNotApproved();

        _safeTransferFrom(token, msg.sender, amount);
        _safeApproveWithRetry(token, target, amount);

        /// @solidity memory-safe-assembly
        assembly {
            let m := mload(0x40)
            calldatacopy(m, bridgeCalldata.offset, bridgeCalldata.length)
            if iszero(call(gas(), target, callvalue(), m, bridgeCalldata.length, 0x00, 0x00)) {
                returndatacopy(m, 0x00, returndatasize())
                revert(m, returndatasize())
            }
        }

        _safeApprove(token, target, 0);

        uint256 leftover = _balanceOf(token);
        if (leftover != 0) _safeTransfer(token, msg.sender, leftover);

        _refundETH();

        emit BridgeInitiated(msg.sender, target, token, amount, destChainId);
    }

    /// @notice Bridge native ETH through an approved target.
    /// @dev Forwards msg.value with calldata to target, refunds any remaining ETH balance.
    /// @param target Approved bridge contract to call.
    /// @param destChainId Destination chain (logged in event, not validated on-chain).
    /// @param bridgeCalldata Raw calldata to forward to the bridge contract.
    function bridgeNative(
        address target,
        uint256 destChainId,
        bytes calldata bridgeCalldata
    ) external payable nonReentrant {
        if (bridgeMeta[target].name == 0) revert TargetNotApproved();

        /// @solidity memory-safe-assembly
        assembly {
            let m := mload(0x40)
            calldatacopy(m, bridgeCalldata.offset, bridgeCalldata.length)
            if iszero(call(gas(), target, callvalue(), m, bridgeCalldata.length, 0x00, 0x00)) {
                returndatacopy(m, 0x00, returndatasize())
                revert(m, returndatasize())
            }
        }

        _refundETH();

        emit BridgeInitiated(msg.sender, target, ETH, msg.value, destChainId);
    }

    /// @notice Bridge ERC20 tokens via Permit2 signature transfer.
    /// @dev Uses Permit2 to pull tokens (no prior rAgg approval needed), then routes as normal.
    ///      Optionally emits BridgeRef if ref is nonzero.
    /// @param target Approved bridge contract to call.
    /// @param token ERC20 token to bridge.
    /// @param amount Amount to transfer and bridge.
    /// @param destChainId Destination chain (logged in event, not validated on-chain).
    /// @param bridgeCalldata Raw calldata to forward to the bridge contract.
    /// @param nonce Permit2 nonce (unique per signature, managed off-chain).
    /// @param deadline Permit2 signature deadline (unix timestamp).
    /// @param signature Permit2 EIP-712 signature from msg.sender.
    /// @param ref Source tag (e.g. "which.wei-ui"). Pass bytes16(0) to skip.
    function bridgeERC20Permit2(
        address target,
        address token,
        uint256 amount,
        uint256 destChainId,
        bytes calldata bridgeCalldata,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature,
        bytes16 ref
    ) external payable nonReentrant {
        if (bridgeMeta[target].name == 0) revert TargetNotApproved();

        _permit2TransferFrom(token, amount, nonce, deadline, signature);
        _safeApproveWithRetry(token, target, amount);
        _forwardCall(target, bridgeCalldata);
        _safeApprove(token, target, 0);

        uint256 leftover = _balanceOf(token);
        if (leftover != 0) _safeTransfer(token, msg.sender, leftover);

        _refundETH();

        emit BridgeInitiated(msg.sender, target, token, amount, destChainId);
        if (ref != 0) emit BridgeRef(ref);
    }

    /// @notice Bridge ERC20 tokens with a source reference tag.
    /// @param target Approved bridge contract to call.
    /// @param token ERC20 token to bridge.
    /// @param amount Amount to pull from sender and approve.
    /// @param destChainId Destination chain (logged in event, not validated on-chain).
    /// @param bridgeCalldata Raw calldata to forward to the bridge contract.
    /// @param ref Source tag. Pass bytes16(0) to skip.
    function bridgeERC20Ref(
        address target,
        address token,
        uint256 amount,
        uint256 destChainId,
        bytes calldata bridgeCalldata,
        bytes16 ref
    ) external payable nonReentrant {
        if (bridgeMeta[target].name == 0) revert TargetNotApproved();

        _safeTransferFrom(token, msg.sender, amount);
        _safeApproveWithRetry(token, target, amount);
        _forwardCall(target, bridgeCalldata);
        _safeApprove(token, target, 0);

        uint256 leftover = _balanceOf(token);
        if (leftover != 0) _safeTransfer(token, msg.sender, leftover);

        _refundETH();

        emit BridgeInitiated(msg.sender, target, token, amount, destChainId);
        if (ref != 0) emit BridgeRef(ref);
    }

    /// @notice Bridge native ETH with a source reference tag.
    /// @param target Approved bridge contract to call.
    /// @param destChainId Destination chain (logged in event, not validated on-chain).
    /// @param bridgeCalldata Raw calldata to forward to the bridge contract.
    /// @param ref Source tag. Pass bytes16(0) to skip.
    function bridgeNativeRef(
        address target,
        uint256 destChainId,
        bytes calldata bridgeCalldata,
        bytes16 ref
    ) external payable nonReentrant {
        if (bridgeMeta[target].name == 0) revert TargetNotApproved();

        _forwardCall(target, bridgeCalldata);
        _refundETH();

        emit BridgeInitiated(msg.sender, target, ETH, msg.value, destChainId);
        if (ref != 0) emit BridgeRef(ref);
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Approve a new bridge target (or update an existing one). Owner only.
    /// @param target Bridge contract address (must not be zero or self).
    /// @param name Provider name (right-padded, max 26 chars, must not be zero).
    /// @param chains Bitmap of supported chain IDs.
    /// @param tokens Bitmap of supported token symbols.
    function addTarget(
        address target,
        bytes26 name,
        uint32 chains,
        uint16 tokens
    ) external payable onlyOwner {
        if (target == address(0) || target == address(this)) revert InvalidTarget();
        if (name == 0) revert InvalidTarget();
        if (chains >= (1 << chainIds.length)) revert BitmapOverflow();
        if (tokens >= (1 << tokenSymbols.length)) revert BitmapOverflow();
        bridgeMeta[target] = BridgeMeta(name, chains, tokens);
        if (targetIndexPlusOne[target] == 0) {
            targetList.push(target);
            targetIndexPlusOne[target] = targetList.length;
        }
        emit TargetAdded(target, name, chains, tokens);
    }

    /// @notice Remove a bridge target's approval. Owner only.
    /// @param target Bridge contract to de-approve.
    function removeTarget(address target) external payable onlyOwner {
        delete bridgeMeta[target];
        uint256 iPlusOne = targetIndexPlusOne[target];
        if (iPlusOne != 0) {
            uint256 i = iPlusOne - 1;
            uint256 last = targetList.length - 1;
            if (i != last) {
                address moved = targetList[last];
                targetList[i] = moved;
                targetIndexPlusOne[moved] = iPlusOne;
            }
            targetList.pop();
            delete targetIndexPlusOne[target];
        }
        emit TargetRemoved(target);
    }

    /// @notice Rescue stuck tokens or ETH. Owner only.
    /// @param token Token to rescue (use ETH sentinel for native ETH).
    /// @param amount Amount to rescue.
    /// @param to Recipient address (must not be zero).
    function rescueToken(address token, uint256 amount, address to) external payable onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (token == ETH) {
            _safeTransferETH(to, amount);
        } else {
            _safeTransfer(token, to, amount);
        }
        emit Rescued(token, amount, to);
    }

    /*//////////////////////////////////////////////////////////////
                               METADATA
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns all currently approved target addresses.
    /// @return List of target addresses.
    function getTargets() external view returns (address[] memory) {
        return targetList;
    }

    /// @notice Returns all registered chain IDs.
    /// @return List of chain IDs.
    function getChainIds() external view returns (uint256[] memory) {
        return chainIds;
    }

    /// @notice Returns all registered token symbols.
    /// @return List of token symbols as bytes32.
    function getTokenSymbols() external view returns (bytes32[] memory) {
        return tokenSymbols;
    }

    /// @notice Append a new chain ID to the registry. Owner only.
    /// @param chainId Chain ID to add.
    function addChainId(uint256 chainId) external payable onlyOwner {
        if (chainIds.length >= MAX_CHAIN_BITS) revert BitmapOverflow();
        chainIds.push(chainId);
    }

    /// @notice Overwrite a chain ID at a given index. Owner only.
    /// @param index Index in the chainIds array.
    /// @param chainId New chain ID value.
    function setChainId(uint256 index, uint256 chainId) external payable onlyOwner {
        if (index >= chainIds.length) revert OutOfBounds();
        chainIds[index] = chainId;
    }

    /// @notice Append a new token symbol to the registry. Owner only.
    /// @param symbol Token symbol as bytes32.
    function addTokenSymbol(bytes32 symbol) external payable onlyOwner {
        if (tokenSymbols.length >= MAX_TOKEN_BITS) revert BitmapOverflow();
        tokenSymbols.push(symbol);
    }

    /// @notice Overwrite a token symbol at a given index. Owner only.
    /// @param index Index in the tokenSymbols array.
    /// @param symbol New token symbol value.
    function setTokenSymbol(uint256 index, bytes32 symbol) external payable onlyOwner {
        if (index >= tokenSymbols.length) revert OutOfBounds();
        tokenSymbols[index] = symbol;
    }

    /*//////////////////////////////////////////////////////////////
                             INTERNAL OPS
    //////////////////////////////////////////////////////////////*/

    /// @dev Forward calldata to an approved bridge target, passing along msg.value.
    function _forwardCall(address target, bytes calldata bridgeCalldata) internal {
        /// @solidity memory-safe-assembly
        assembly {
            let m := mload(0x40)
            calldatacopy(m, bridgeCalldata.offset, bridgeCalldata.length)
            if iszero(call(gas(), target, callvalue(), m, bridgeCalldata.length, 0x00, 0x00)) {
                returndatacopy(m, 0x00, returndatasize())
                revert(m, returndatasize())
            }
        }
    }

    /// @dev Solady SafeTransferLib patterns.
    function _safeTransferFrom(address token, address from, uint256 amount) internal {
        /// @solidity memory-safe-assembly
        assembly {
            let m := mload(0x40)
            mstore(0x60, amount)
            mstore(0x40, address())
            mstore(0x2c, shl(96, from))
            mstore(0x0c, 0x23b872dd000000000000000000000000)
            let success := call(gas(), token, 0, 0x1c, 0x64, 0x00, 0x20)
            if iszero(and(eq(mload(0x00), 1), success)) {
                if iszero(lt(or(iszero(extcodesize(token)), returndatasize()), success)) {
                    mstore(0x00, 0x7939f424) // TransferFromFailed()
                    revert(0x1c, 0x04)
                }
            }
            mstore(0x60, 0)
            mstore(0x40, m)
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        /// @solidity memory-safe-assembly
        assembly {
            mstore(0x14, to)
            mstore(0x34, amount)
            mstore(0x00, 0xa9059cbb000000000000000000000000)
            let success := call(gas(), token, 0, 0x10, 0x44, 0x00, 0x20)
            if iszero(and(eq(mload(0x00), 1), success)) {
                if iszero(lt(or(iszero(extcodesize(token)), returndatasize()), success)) {
                    mstore(0x00, 0x90b8ec18) // TransferFailed()
                    revert(0x1c, 0x04)
                }
            }
            mstore(0x34, 0)
        }
    }

    function _safeApprove(address token, address to, uint256 amount) internal {
        /// @solidity memory-safe-assembly
        assembly {
            mstore(0x14, to)
            mstore(0x34, amount)
            mstore(0x00, 0x095ea7b3000000000000000000000000)
            let success := call(gas(), token, 0, 0x10, 0x44, 0x00, 0x20)
            if iszero(and(eq(mload(0x00), 1), success)) {
                if iszero(lt(or(iszero(extcodesize(token)), returndatasize()), success)) {
                    mstore(0x00, 0x3e3f8f73) // ApproveFailed()
                    revert(0x1c, 0x04)
                }
            }
            mstore(0x34, 0)
        }
    }

    /// @dev Reset-to-0 retry for USDT-like tokens.
    function _safeApproveWithRetry(address token, address to, uint256 amount) internal {
        /// @solidity memory-safe-assembly
        assembly {
            mstore(0x14, to)
            mstore(0x34, amount)
            mstore(0x00, 0x095ea7b3000000000000000000000000)
            let success := call(gas(), token, 0, 0x10, 0x44, 0x00, 0x20)
            if iszero(and(eq(mload(0x00), 1), success)) {
                if iszero(lt(or(iszero(extcodesize(token)), returndatasize()), success)) {
                    mstore(0x34, 0)
                    mstore(0x00, 0x095ea7b3000000000000000000000000)
                    pop(call(gas(), token, 0, 0x10, 0x44, codesize(), 0x00))
                    mstore(0x34, amount)
                    success := call(gas(), token, 0, 0x10, 0x44, 0x00, 0x20)
                    if iszero(and(eq(mload(0x00), 1), success)) {
                        if iszero(lt(or(iszero(extcodesize(token)), returndatasize()), success)) {
                            mstore(0x00, 0x3e3f8f73) // ApproveFailed()
                            revert(0x1c, 0x04)
                        }
                    }
                }
            }
            mstore(0x34, 0)
        }
    }

    function _safeTransferETH(address to, uint256 amount) internal {
        /// @solidity memory-safe-assembly
        assembly {
            if iszero(call(gas(), to, amount, codesize(), 0x00, codesize(), 0x00)) {
                mstore(0x00, 0xb12d13eb) // ETHTransferFailed()
                revert(0x1c, 0x04)
            }
        }
    }

    function _balanceOf(address token) internal view returns (uint256 bal) {
        /// @solidity memory-safe-assembly
        assembly {
            mstore(0x14, address())
            mstore(0x00, 0x70a08231000000000000000000000000)
            bal := mul(
                mload(0x20),
                and(gt(returndatasize(), 0x1f), staticcall(gas(), token, 0x10, 0x24, 0x20, 0x20))
            )
        }
    }

    function _refundETH() internal {
        /// @solidity memory-safe-assembly
        assembly {
            let bal := selfbalance()
            if bal {
                if iszero(call(gas(), caller(), bal, codesize(), 0x00, codesize(), 0x00)) {
                    mstore(0x00, 0xb12d13eb) // ETHTransferFailed()
                    revert(0x1c, 0x04)
                }
            }
        }
    }

    /// @dev Pull tokens from msg.sender via Permit2 SignatureTransfer.
    ///      Reverts if Permit2 is not deployed on this chain.
    function _permit2TransferFrom(
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        address permit2 = PERMIT2;
        /// @solidity memory-safe-assembly
        assembly {
            if iszero(extcodesize(permit2)) {
                mstore(0x00, 0xe70ff93c) // Permit2NotDeployed()
                revert(0x1c, 0x04)
            }
        }
        IPermit2(permit2).permitTransferFrom(
            IPermit2.PermitTransferFrom({
                permitted: IPermit2.TokenPermissions({token: token, amount: amount}),
                nonce: nonce,
                deadline: deadline
            }),
            IPermit2.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
            msg.sender,
            signature
        );
    }
}
