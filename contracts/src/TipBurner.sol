// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPonsFactory, IPonsCurve, PonsLaunchedToken, IERC20S, PonsAddrs} from "./PonsTypes.sol";

struct PoolKeyB {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParamsB {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManagerB {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKeyB memory key, SwapParamsB memory params, bytes calldata hookData) external returns (int256);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// @title Stock Tips burner
/// Receives 15% of every jar harvest. Anyone can spend it on $STIPS: on the Pons curve before graduation, in its Uniswap v4
/// pool after, and every token bought goes straight to the dead address. At most 0.25 ETH per call, with a caller-set
/// minimum output. There is no withdraw function; $STIPS can be set once.
contract TipBurner {
    uint256 public constant MAX_BURN = 0.25 ether;
    uint160 internal constant MIN_SQRT = 4295128740;

    address public owner;
    address public stips;
    uint256 public totalReceived;
    uint256 public burnedEth;
    uint256 public burnedTokens;
    bool internal entered;

    event Burned(address indexed caller, uint256 ethIn, uint256 tokens, bool onCurve);
    event StipsSet(address token);

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {
        totalReceived += msg.value;
    }

    function setStips(address token) external {
        require(msg.sender == owner, "owner");
        require(stips == address(0) && token != address(0), "set");
        PonsLaunchedToken memory lt = IPonsFactory(PonsAddrs.FACTORY).getLaunchedToken(token);
        require(lt.exists && lt.pairToken == address(0), "not a pons eth launch");
        stips = token;
        emit StipsSet(token);
    }

    function burn(uint256 ethIn, uint256 minOut) external returns (uint256 spent, uint256 tokens, bool onCurve) {
        require(!entered, "reentrant");
        entered = true;
        require(stips != address(0), "stips not set");
        require(minOut > 0, "min out");
        require(ethIn > 0 && ethIn <= MAX_BURN && ethIn <= address(this).balance, "amount");
        PonsLaunchedToken memory lt = IPonsFactory(PonsAddrs.FACTORY).getLaunchedToken(stips);
        uint256 ethBefore = address(this).balance;
        uint256 deadBefore = IERC20S(stips).balanceOf(PonsAddrs.DEAD);
        onCurve = lt.phase < 2;
        if (onCurve) {
            IPonsCurve(lt.curve).buy{value: ethIn}(ethIn, minOut, PonsAddrs.DEAD);
        } else {
            PoolKeyB memory key = PoolKeyB(address(0), stips, lt.poolFee, lt.tickSpacing, IPonsFactory(PonsAddrs.FACTORY).memeHook());
            IPoolManagerB(PonsAddrs.POOL_MANAGER).unlock(abi.encode(key, ethIn));
        }
        spent = ethBefore - address(this).balance;
        tokens = IERC20S(stips).balanceOf(PonsAddrs.DEAD) - deadBefore;
        require(spent > 0 && spent <= ethIn && tokens >= minOut, "min out");
        burnedEth += spent;
        burnedTokens += tokens;
        emit Burned(msg.sender, spent, tokens, onCurve);
        entered = false;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == PonsAddrs.POOL_MANAGER, "pool manager");
        (PoolKeyB memory key, uint256 ethIn) = abi.decode(data, (PoolKeyB, uint256));
        int256 d = IPoolManagerB(PonsAddrs.POOL_MANAGER).swap(key, SwapParamsB(true, -int256(ethIn), MIN_SQRT), "");
        int128 paid = int128(d >> 128);
        int128 got = int128(d);
        require(paid < 0 && uint256(uint128(-paid)) <= ethIn && got > 0, "swap");
        IPoolManagerB(PonsAddrs.POOL_MANAGER).settle{value: uint256(uint128(-paid))}();
        IPoolManagerB(PonsAddrs.POOL_MANAGER).take(key.currency1, PonsAddrs.DEAD, uint256(uint128(got)));
        return "";
    }

    function transferOwnership(address next) external {
        require(msg.sender == owner, "owner");
        owner = next;
    }
}
