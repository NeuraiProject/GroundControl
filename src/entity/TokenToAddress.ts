import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

@Entity()
@Index(["token", "chain", "address"], { unique: true })
@Index(["chain", "address"], { unique: false })
export class TokenToAddress {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  token: string;

  @Column()
  os: string;

  @Column()
  address: string;

  /** Neurai chain this subscription belongs to ('mainnet' | 'testnet'). */
  @Column({ default: "mainnet" })
  chain: string;

  @Column({ type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  created: Date;
}
