import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

@Entity()
@Index(["token", "chain", "txid"], { unique: true })
@Index(["chain", "txid"], { unique: false })
@Index(["created"], { unique: false })
export class TokenToTxid {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  token: string;

  @Column()
  os: string;

  @Column()
  txid: string;

  /** Neurai chain this subscription belongs to ('mainnet' | 'testnet'). */
  @Column({ default: "mainnet" })
  chain: string;

  @Column({ type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  created: Date;
}
