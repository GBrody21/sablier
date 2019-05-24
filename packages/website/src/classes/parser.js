import dayjs from "dayjs";

import { BigNumber as BN } from "bignumber.js";
import { toChecksumAddress } from "web3-utils";

import { formatDuration, formatTime, roundToDecimalPoints } from "../helpers/format-utils";
import { getEtherscanTransactionLink } from "../helpers/web3-utils";
import { getMinutesForBlockDelta, getTimeForBlockDelta } from "../helpers/time-utils";
import { getUnitValue } from "../helpers/token-utils";
import { StreamFlow, StreamStatus } from "./stream";

export const initialState = {
  flow: "",
  from: "",
  funds: {
    deposit: 0,
    paid: 0,
    ratio: 0,
    remaining: 0,
    withdrawable: 0,
    withdrawn: 0,
  },
  link: "",
  rate: "",
  rawStreamId: "",
  redemption: null,
  startTime: "",
  status: "",
  stopTime: "",
  to: "",
  token: {
    address: "",
    symbol: "",
  },
};

/**
 * Class to handle actions related to streams stored in the subgraph
 */
export class Parser {
  constructor(stream, account, blockNumber, translations) {
    this.account = toChecksumAddress(account);
    this.blockNumber = new BN(blockNumber);
    this.translations = translations;

    // See the following
    // - https://stackoverflow.com/questions/13104494/does-javascript-pass-by-reference
    // - https://stackoverflow.com/questions/122102/what-is-the-most-efficient-way-to-deep-clone-an-object-in-javascript/5344074#5344074
    this.stream = stream; //JSON.parse(JSON.stringify(stream));
    this.stream.rawStream.interval = new BN(stream.rawStream.interval);
    this.stream.rawStream.payment = new BN(stream.rawStream.payment);
    this.stream.rawStream.recipient = toChecksumAddress(stream.rawStream.recipient);
    this.stream.rawStream.sender = toChecksumAddress(stream.rawStream.sender);
    this.stream.rawStream.startBlock = new BN(stream.rawStream.startBlock);
    this.stream.rawStream.stopBlock = new BN(stream.rawStream.stopBlock);

    // Highly important function, but also really tricky. In the subgraph, it is not possible to continuously
    // update the status based on the current block number (smart contracts cannot act like cron jobs).
    // Therefore, it is up to the client to compute the status based on the current block number.
    let status = StreamStatus.UNDEFINED.name;
    if (!stream.rawStream.redemption) {
      if (this.blockNumber.isLessThan(this.stream.rawStream.startBlock)) {
        status = StreamStatus.CREATED.name;
      } else if (
        this.blockNumber.isGreaterThanOrEqualTo(this.stream.rawStream.startBlock) &&
        this.blockNumber.isLessThanOrEqualTo(this.stream.rawStream.stopBlock)
      ) {
        status = StreamStatus.ACTIVE.name;
      } else {
        status = StreamStatus.ENDED.name;
      }
    } else {
      // Humans would arguably understand better the concept of a stream being "Ended" when
      // that stream has successfully paid the recipient all the funds deposited initially.
      if (stream.rawStream.redemption.senderAmount === 0) {
        status = StreamStatus.ENDED.name;
      } else {
        status = StreamStatus.REDEEMED.name;
      }
    }
    this.stream.rawStream.status = status;
  }

  parseAddresses() {
    const { stream, translations } = this;
    const { flow, rawStream } = stream;
    const { recipient, sender } = rawStream;

    if (flow === StreamFlow.IN.name) {
      return {
        from: {
          long: sender,
          short: `${sender.substring(0, 6)}...${sender.substring(38)}`,
        },
        to: {
          long: translations("you"),
          short: translations("you"),
        },
      };
    }

    if (flow === StreamFlow.OUT.name) {
      return {
        from: {
          long: translations("you"),
          short: translations("you"),
        },
        to: {
          long: recipient,
          short: `${recipient.substring(0, 6)}...${recipient.substring(38)}`,
        },
      };
    }

    return {
      from: {
        long: "",
        short: "",
      },
      to: {
        long: "",
        short: "",
      },
    };
  }

  parseFunds() {
    const { stream, blockNumber } = this;
    const { rawStream } = stream;
    const { interval, payment, startBlock, stopBlock, token, withdrawals } = rawStream;

    const totalBlockDeltaBN = stopBlock.minus(startBlock);
    const depositBN = totalBlockDeltaBN.dividedBy(interval).multipliedBy(payment);
    const depositValue = getUnitValue(depositBN, token.decimals, { decimalPoints: 2 });

    if (rawStream.status === StreamStatus.CREATED.name || rawStream.status === StreamStatus.UNDEFINED.name) {
    }

    let blockDeltaBN;
    switch (rawStream.status) {
      case StreamStatus.ACTIVE.name:
        blockDeltaBN = blockNumber.minus(startBlock);
        const modulusBN = blockDeltaBN.modulo(interval);
        blockDeltaBN = blockDeltaBN.minus(modulusBN);
        break;
      case StreamStatus.REDEEMED.name:
        const redemptionBlockNumber = rawStream.txs[rawStream.txs.length - 1].block;
        const redemptionBlockNumberBN = new BN(redemptionBlockNumber);
        if (redemptionBlockNumberBN.isLessThanOrEqualTo(startBlock)) {
          blockDeltaBN = new BN(0);
        } else {
          blockDeltaBN = redemptionBlockNumberBN.minus(startBlock);
        }
        break;
      case StreamStatus.ENDED.name:
        blockDeltaBN = stopBlock.minus(startBlock);
        break;
      default:
        return {
          deposit: depositValue,
          paid: 0,
          ratio: 0,
          remaining: depositValue,
          withdrawable: 0,
          withdrawn: 0,
        };
    }

    const paidBN = blockDeltaBN.dividedBy(interval).multipliedBy(payment);
    const paidValue = getUnitValue(paidBN, token.decimals, { decimalPoints: 2 });
    const remainingBN = depositBN.minus(paidBN);
    const remainingValue = getUnitValue(remainingBN, token.decimals, { decimalPoints: 2 });

    const ratioBN = paidBN.dividedBy(depositBN).multipliedBy(new BN(100));
    const ratioValue = roundToDecimalPoints(ratioBN.toNumber(), 0);

    let withdrawnBN = new BN(0);
    withdrawals.forEach((withdrawal) => {
      withdrawnBN = withdrawnBN.plus(new BN(withdrawal.amount));
    });
    let withdrawnValue = getUnitValue(withdrawnBN, token.decimals, { decimalPoints: 2 });

    let withdrawableBN = paidBN.minus(withdrawnBN);
    let withdrawableValue = getUnitValue(withdrawableBN, token.decimals, { decimalPoints: 2 });

    return {
      deposit: depositValue,
      paid: paidValue,
      ratio: ratioValue,
      remaining: remainingValue,
      withdrawable: withdrawableValue,
      withdrawn: withdrawnValue,
    };
  }

  parseRate() {
    const { stream, translations } = this;
    const { rawStream } = stream;

    // TODO: use the Etherscan API for calculating time and be loose with off-by-one errors.
    // At the moment, the string interval won't be resolved lest the BLOCK_TIME_AVERAGE is
    // 15 seconds.
    const paymentBN = new BN(rawStream.payment);
    const payment = getUnitValue(paymentBN, rawStream.token.decimals, { decimalPoints: 2 });
    const minutes = getMinutesForBlockDelta(rawStream.interval);

    let formattedInterval = formatDuration(translations, minutes)
      .replace(`1 ${translations("month")}`, translations("month"))
      .replace(`1 ${translations("day")}`, translations("day"))
      .replace(`1 ${translations("hour")}`, translations("hour"))
      .replace(`1 ${translations("min")}`, translations("min"));
    return `${payment} ${rawStream.token.symbol}/ ${formattedInterval.toLowerCase()}`;
  }

  parseRedemption() {
    const { stream, translations } = this;
    const { rawStream } = stream;

    if (rawStream.status !== StreamStatus.REDEEMED.name) {
      return {};
    }

    const timestamp = rawStream.txs[rawStream.txs.length - 1].timestamp;
    const redemptionTime = formatTime(translations, dayjs.unix(timestamp));

    return {
      ...rawStream.redemption,
      time: redemptionTime,
    };
  }

  parseTimes() {
    const { stream, blockNumber, translations } = this;
    const { rawStream } = stream;
    const { startBlock, stopBlock } = rawStream;

    const blockNumberBN = new BN(blockNumber);
    const intervalInMinutes = getMinutesForBlockDelta(rawStream.interval);
    let startTime, stopTime;

    // Not using the `status` here because start and stop times are independent of it
    // Before the start of the stream
    if (blockNumber.isLessThanOrEqualTo(startBlock)) {
      const startBlockDelta = startBlock.minus(blockNumber).toNumber();
      const startDate = getTimeForBlockDelta(startBlockDelta, false);
      startTime = formatTime(translations, startDate, { minimumInterval: intervalInMinutes, prettyPrint: true });

      const stopBlockDelta = stopBlock.minus(blockNumber).toNumber();
      const stopDate = getTimeForBlockDelta(stopBlockDelta, false);
      stopTime = formatTime(translations, stopDate, { minimumInterval: intervalInMinutes, prettyPrint: true });
    }
    // During the stream
    else if (blockNumber.isLessThanOrEqualTo(stopBlock)) {
      const startBlockDelta = blockNumberBN.minus(startBlock).toNumber();
      const startMinutes = getMinutesForBlockDelta(startBlockDelta);
      const startDuration = formatDuration(translations, startMinutes, intervalInMinutes).toLowerCase();
      startTime = `${startDuration} ${translations("ago").toLowerCase()}`;

      const stopBlockDelta = stopBlock.minus(blockNumber).toNumber();
      const stopMinutes = getMinutesForBlockDelta(stopBlockDelta);
      const stopDuration = formatDuration(translations, stopMinutes, intervalInMinutes).toLowerCase();
      stopTime = `${stopDuration} ${translations("left").toLowerCase()}`;
    }
    // After the end of the stream
    else {
      const startBlockDelta = blockNumberBN.minus(startBlock).toNumber();
      const startDate = getTimeForBlockDelta(startBlockDelta, true);
      startTime = formatTime(translations, startDate, { minimumInterval: intervalInMinutes, prettyPrint: true });

      const stopBlockDelta = blockNumberBN.minus(stopBlock).toNumber();
      const stopDate = getTimeForBlockDelta(stopBlockDelta, true);
      stopTime = formatTime(translations, stopDate, { minimumInterval: intervalInMinutes, prettyPrint: true });
    }

    return { startTime, stopTime };
  }

  parse() {
    const { stream } = this;
    const { flow, rawStream } = stream;
    const { token, txs } = rawStream;

    const funds = this.parseFunds();
    const { from, to } = this.parseAddresses();
    const link = getEtherscanTransactionLink(txs[0].id);
    const rate = this.parseRate();
    const redemption = this.parseRedemption();
    const { startTime, stopTime } = this.parseTimes();
    const tokenAddress = toChecksumAddress(token.id);

    return {
      flow: flow.toUpperCase(),
      from,
      funds,
      link,
      rate,
      rawStreamId: rawStream.id,
      redemption,
      to,
      startTime,
      status: rawStream.status,
      stopTime,
      token: {
        address: tokenAddress,
        symbol: token.symbol,
      },
    };
  }
}