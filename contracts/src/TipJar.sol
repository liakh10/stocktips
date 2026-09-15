// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPonsEscrow, IPonsCurve, IERC20S, PonsAddrs} from "./PonsTypes.sol";

interface ITipFactoryJ {
    function oracle() external view returns (address);
    function guardian() external view returns (address);
    function burner() external view returns (address);
}

interface IFeedJ {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IV3PoolJ {
    function token0() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256);
}

interface IWETHJ {
    function deposit() external payable;
}

/// @title Stock Tips jar
/// One jar per X handle, created by the Stock Tips factory the first time someone opens a coin for that handle. The jar is
/// the Pons creator fee recipient of every coin of the handle. `harvest` claims those fees from the Pons escrow, sends 15%
/// to the $STIPS burner and turns the rest into NVDA through the Uniswap V3 WETH/NVDA pool at no worse than the Chainlink
/// price minus 2%. The NVDA waits here for the owner of the handle.
///
/// Claiming: the owner proves the handle with a public post, the Stock Tips oracle signs (handle, wallet, nonce, deadline)
/// and `bind` starts a 48 hour wait that the guardian or the current wallet can cancel. After the wait `confirm` sets the
/// wallet and `payout` sends everything in the jar to it, now and on every later harvest.
contract TipJar {
    uint256 public constant BURN_BPS = 1500;
    uint256 public constant BIND_DELAY = 48 hours;
    uint256 public constant MAX_BUY = 1 ether;
    uint256 public constant MIN_BUY = 0.0005 ether;
    uint256 public constant MAX_SLIPPAGE_BPS = 200;
    uint256 public constant MAX_FEED_AGE = 4 days;
    uint160 internal constant MIN_SQRT = 4295128740;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    ITipFactoryJ public factory;
    bytes32 public handleHash;
    string public handle;
    address public wallet;
    address public pendingWallet;
    uint64 public pendingAt;
    uint256 public nonce;

    uint256 public totalClaimed;
    uint256 public totalBurnShare;
    uint256 public totalEthSpent;
    uint256 public totalNvdaBought;
    uint256 public totalPaidNvda;
    uint256 public totalPaidEth;

    bool internal initialized;
    bool internal entered;
    address internal activePool;

    event Harvested(uint256 claimed, uint256 toBurner, uint256 ethSpent, uint256 nvdaBought);
    event BindStarted(address indexed wallet, uint256 nonce, uint64 readyAt);
    event BindCancelled(address indexed wallet, address indexed by);
    event WalletSet(address indexed wallet);
    event Paid(address indexed wallet, uint256 nvda, uint256 eth);

    modifier nonReentrant() {
        require(!entered, "reentrant");
        entered = true;
        _;
        entered = false;
    }

    constructor() {
        initialized = true;
    }

    function initialize(string calldata _handle) external {
        require(!initialized, "init");
        initialized = true;
        factory = ITipFactoryJ(msg.sender);
        handle = _handle;
        handleHash = keccak256(bytes(_handle));
    }

    receive() external payable {}

    // ---------------------------------------------------------------- fees

    /// Claims creator fees from the Pons escrow, pays the burner its share and buys NVDA with up to MAX_BUY of the rest.
    /// Anyone can call it. If a Chainlink price is stale the ETH simply waits for the next harvest.
    function harvest() external nonReentrant returns (uint256 claimed, uint256 bought) {
        if (IPonsEscrow(PonsAddrs.ESCROW).balanceOf(address(this)) > 0) {
            uint256 before = address(this).balance;
            IPonsEscrow(PonsAddrs.ESCROW).claim();
            claimed = address(this).balance - before;
        }
        uint256 toBurner = claimed * BURN_BPS / 10_000;
        if (toBurner > 0) {
            (bool ok,) = factory.burner().call{value: toBurner}("");
            if (ok) totalBurnShare += toBurner;
        }
        totalClaimed += claimed;
        uint256 spend = address(this).balance;
        if (spend > MAX_BUY) spend = MAX_BUY;
        uint256 spent;
        if (spend >= MIN_BUY) (spent, bought) = _buyNvda(spend);
        emit Harvested(claimed, toBurner, spent, bought);
        if (wallet != address(0)) _pay();
    }

    /// Pons records the jar as the deployer of its coins, so only the jar can move curve fees into the escrow.
    /// The factory asks for it; a curve that refuses simply returns false.
    function sweepCurve(address curve) external returns (bool ok) {
        require(msg.sender == address(factory), "factory");
        try IPonsCurve(curve).sweepFees(0) { ok = true; } catch { ok = false; }
    }

    function _buyNvda(uint256 ethIn) internal returns (uint256 spent, uint256 bought) {
        (bool fresh, uint256 ethUsd) = _price(PonsAddrs.ETH_USD);
        (bool fresh2, uint256 nvdaUsd) = _price(PonsAddrs.NVDA_USD);
        if (!fresh || !fresh2) return (0, 0);
        uint256 minOut = ethIn * ethUsd / nvdaUsd * (10_000 - MAX_SLIPPAGE_BPS) / 10_000;
        uint256 before = IERC20S(PonsAddrs.NVDA).balanceOf(address(this));
        IWETHJ(PonsAddrs.WETH).deposit{value: ethIn}();
        address pool = PonsAddrs.WETH_NVDA_POOL;
        bool zeroForOne = IV3PoolJ(pool).token0() == PonsAddrs.WETH;
        activePool = pool;
        IV3PoolJ(pool).swap(address(this), zeroForOne, int256(ethIn), zeroForOne ? MIN_SQRT : MAX_SQRT, "");
        activePool = address(0);
        bought = IERC20S(PonsAddrs.NVDA).balanceOf(address(this)) - before;
        require(bought >= minOut, "slippage");
        spent = ethIn;
        totalEthSpent += ethIn;
        totalNvdaBought += bought;
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        require(msg.sender == activePool && activePool != address(0), "pool");
        require(IERC20S(PonsAddrs.WETH).transfer(msg.sender, uint256(a0 > 0 ? a0 : a1)), "pay");
    }

    function _price(address feed) internal view returns (bool fresh, uint256 price) {
        (, int256 answer,, uint256 updatedAt,) = IFeedJ(feed).latestRoundData();
        fresh = answer > 0 && updatedAt + MAX_FEED_AGE >= block.timestamp;
        price = answer > 0 ? uint256(answer) : 0;
    }

    // ---------------------------------------------------------------- claiming

    /// The message the oracle signs after checking the handle's public post.
    function bindDigest(address to, uint256 bindNonce, uint256 deadline) public view returns (bytes32) {
        bytes32 inner = keccak256(abi.encode(keccak256("STOCK_TIPS_BIND"), block.chainid, address(this), handleHash, to, bindNonce, deadline));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    /// Starts the 48 hour wait for `to`. Anyone can submit a valid oracle signature.
    function bind(address to, uint256 deadline, bytes calldata signature) external {
        require(to != address(0) && deadline >= block.timestamp, "deadline");
        require(signature.length == 65, "signature");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "signature");
        address signer = ecrecover(bindDigest(to, nonce, deadline), v, r, s);
        require(signer != address(0) && signer == factory.oracle(), "oracle");
        nonce++;
        pendingWallet = to;
        pendingAt = uint64(block.timestamp);
        emit BindStarted(to, nonce - 1, uint64(block.timestamp + BIND_DELAY));
    }

    function cancelBind() external {
        require(pendingWallet != address(0), "nothing pending");
        require(msg.sender == factory.guardian() || (wallet != address(0) && msg.sender == wallet), "guardian");
        emit BindCancelled(pendingWallet, msg.sender);
        pendingWallet = address(0);
        pendingAt = 0;
    }

    function confirm() external {
        require(pendingWallet != address(0), "nothing pending");
        require(block.timestamp >= pendingAt + BIND_DELAY, "wait");
        wallet = pendingWallet;
        pendingWallet = address(0);
        pendingAt = 0;
        emit WalletSet(wallet);
    }

    /// Sends all NVDA and ETH in the jar to the confirmed wallet. Anyone can call it.
    function payout() external nonReentrant {
        require(wallet != address(0), "no wallet");
        _pay();
    }

    function _pay() internal {
        uint256 n = IERC20S(PonsAddrs.NVDA).balanceOf(address(this));
        if (n > 0) {
            require(IERC20S(PonsAddrs.NVDA).transfer(wallet, n), "nvda");
            totalPaidNvda += n;
        }
        uint256 e = address(this).balance;
        if (e > 0) {
            (bool ok,) = wallet.call{value: e}("");
            if (ok) totalPaidEth += e;
        }
        if (n > 0 || e > 0) emit Paid(wallet, n, e);
    }

    // ---------------------------------------------------------------- views

    function state() external view returns (string memory h, address w, address pending, uint64 readyAt, uint256 nvda, uint256 eth, uint256 escrowed) {
        h = handle;
        w = wallet;
        pending = pendingWallet;
        readyAt = pendingAt == 0 ? 0 : pendingAt + uint64(BIND_DELAY);
        nvda = IERC20S(PonsAddrs.NVDA).balanceOf(address(this));
        eth = address(this).balance;
        escrowed = IPonsEscrow(PonsAddrs.ESCROW).balanceOf(address(this));
    }
}
