// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

/// @title FeeOnTransferTokenMock
/// @dev ERC20 mock that takes a fixed percent fee on every transfer/transferFrom
///   and forwards it to a treasury. Mirrors the rounding semantics of the
///   FeeOnTransfer instruction: feeFloor=false rounds the fee up (net down),
///   feeFloor=true rounds the fee down (net up).
contract FeeOnTransferTokenMock is TokenMock {
    uint32 public immutable feeBps;
    address public immutable treasury;
    bool public immutable feeFloor;

    constructor(
        string memory name,
        string memory symbol,
        uint32 feeBps_,
        address treasury_,
        bool feeFloor_
    ) TokenMock(name, symbol) {
        feeBps = feeBps_;
        treasury = treasury_;
        feeFloor = feeFloor_;
    }

    function feeOf(uint256 amount) public view returns (uint256) {
        return feeFloor ? amount * feeBps / 1e9 : Math.ceilDiv(amount * feeBps, 1e9);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = feeOf(value);
        if (fee == 0 || fee >= value) {
            super._update(from, to, value);
            return;
        }

        super._update(from, to, value - fee);
        super._update(from, treasury, fee);
    }
}
