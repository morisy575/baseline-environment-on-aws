import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { aws_rds as rds } from 'aws-cdk-lib';
import { aws_kms as kms } from 'aws-cdk-lib';
import { aws_logs as logs } from 'aws-cdk-lib';
import { aws_sns as sns } from 'aws-cdk-lib';
import { aws_cloudwatch as cw } from 'aws-cdk-lib';
import { aws_cloudwatch_actions as cw_actions } from 'aws-cdk-lib';

export interface BLEADbAuroraPgStackProps extends cdk.StackProps {
  myVpc: ec2.Vpc;
  dbName: string;
  dbUser: string;
  dbPort: string;
  dbAllocatedStorage: number;
  appKey: kms.IKey;
  vpcSubnets: ec2.SubnetSelection;
  alarmTopic: sns.Topic;
}

export class BLEADbAuroraPgStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly dbProxy: rds.DatabaseProxy;
  public readonly dbProxySecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: BLEADbAuroraPgStackProps) {
    super(scope, id, props);

    // Security Group for DB
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc: props.myVpc,
    });

    // Security Group for DBProxy
    const dbProxySecurityGroup = new ec2.SecurityGroup(this, 'DbProxySecurityGroup', {
      vpc: props.myVpc,
    });
    dbSecurityGroup.addIngressRule(dbProxySecurityGroup, ec2.Port.tcp(Number(props.dbPort)), 'to RDS Instance');

    // Create Aurora Cluster
    const cluster = new rds.DatabaseCluster(this, 'Aurora', {
      // for Aurora PostgreSQL
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_11_9,
      }),
      // for Aurora MySQL
      // engine: rds.DatabaseClusterEngine.auroraMysql({
      //   version: rds.AuroraMysqlEngineVersion.VER_2_09_1
      // }),
      credentials: rds.Credentials.fromGeneratedSecret(props.dbUser),
      instanceProps: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
        vpcSubnets: props.vpcSubnets,
        vpc: props.myVpc,
        securityGroups: [dbSecurityGroup],
        enablePerformanceInsights: true,
        performanceInsightEncryptionKey: props.appKey,
        performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT, // 7 days
      },
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      defaultDatabaseName: props.dbName,
      storageEncrypted: true,
      storageEncryptionKey: props.appKey,
      //      cloudwatchLogsExports: ['error', 'general', 'slowquery', 'audit'],  // For Aurora MySQL
      cloudwatchLogsExports: ['postgresql'], // For Aurora PostgreSQL
      cloudwatchLogsRetention: logs.RetentionDays.THREE_MONTHS,
      instanceIdentifierBase: 'instance',
    });

    // RDS Proxy
    // You have two options for security to connect to RDS Proxy. (https://docs.aws.amazon.com/ja_jp/AmazonRDS/latest/UserGuide/rds-proxy-setup.html#rds-proxy-connecting)
    // [*]1. use IAM authentication. This is recommended because it can remove the need to embed or read credentials in your function code). In this guest sample project,  we use IAM authentication.
    // [ ]2. use your native database credentials stored in Secrets Manager. If you want to implement in this way, you have to create IAM policy that allows Lambda function to access DB credentials in Secrets Manager.
    const dbProxy = cluster.addProxy('DbProxy', {
      secrets: [cluster.secret!],
      vpc: props.myVpc,
      vpcSubnets: props.vpcSubnets,
      securityGroups: [dbProxySecurityGroup],
      requireTLS: true,
      iamAuth: true,
    });

    this.dbProxy = dbProxy;
    this.dbProxySecurityGroup = dbProxySecurityGroup;

    // ----------------------- Alarms for RDS -----------------------------

    // Aurora Cluster CPU Utilization
    cluster
      .metricCPUUtilization({
        period: cdk.Duration.minutes(1),
        statistic: cw.Statistic.AVERAGE,
      })
      .createAlarm(this, 'AuroraCPUUtil', {
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        threshold: 90, // percentage
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // Aurora Cluster Freeable Memory (The amount of available random access memory, in bytes)
    // Now it is set to alarm when the free memory space is less than or equal to 1GB.
    // You can check the max memory space of your DB instance from here : https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.DBInstanceClass.html#Concepts.DBInstanceClass.Summary
    cluster
      .metricFreeableMemory({
        period: cdk.Duration.minutes(5),
        statistic: cw.Statistic.AVERAGE,
      })
      .createAlarm(this, 'AuroraFreeableMem', {
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        threshold: 1000000000, // bytes
        comparisonOperator: cw.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // Aurora Cluster Database Connections
    // Now the threshold is set to 90, the default value of DB t3.medium class .
    // You should set the threshold according to your DB cluster instance class. (https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Performance.html#AuroraMySQL.Managing.MaxConnections)
    cluster
      .metricDatabaseConnections({
        period: cdk.Duration.minutes(5),
        statistic: cw.Statistic.AVERAGE,
      })
      .createAlarm(this, 'AuroraDbConnections', {
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        threshold: 90,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // ----------------------- Alarms for RDS  Proxy-----------------------------
    // All the metrics with RDS Proxy -> https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.monitoring.html

    // Availability Percentage
    // The percentage of time for which the target group was available in the role indicated by the dimension.
    new cw.Metric({
      namespace: 'AWS/RDS',
      metricName: 'AvailabilityPercentage',
      period: cdk.Duration.minutes(1),
      statistic: cw.Statistic.AVERAGE,
      dimensionsMap: {
        ProxyName: dbProxy.dbProxyName,
      },
    })
      .createAlarm(this, 'AvailabilityPercentageAlarm', {
        evaluationPeriods: 3,
        threshold: 95, // percentage
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // ClientConnections
    // The current number of client connections.
    new cw.Metric({
      namespace: 'AWS/RDS',
      metricName: 'ClientConnections',
      period: cdk.Duration.minutes(1),
      statistic: cw.Statistic.SUM,
      dimensionsMap: {
        ProxyName: dbProxy.dbProxyName,
      },
    })
      .createAlarm(this, 'ClientConnectionsAlarm', {
        evaluationPeriods: 3,
        threshold: 100, // connections
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // DatabaseConnections
    // The current number of database connections.
    new cw.Metric({
      namespace: 'AWS/RDS',
      metricName: 'DatabaseConnections',
      period: cdk.Duration.minutes(1),
      statistic: cw.Statistic.SUM,
      dimensionsMap: {
        ProxyName: dbProxy.dbProxyName,
      },
    })
      .createAlarm(this, 'DatabaseConnectionsAlarm', {
        evaluationPeriods: 3,
        // Now the threshold is set to 90, the default value of DB t3.medium class .
        // You should set the threshold according to your DB cluster instance class.
        // In checking the max_connections (the maximum number of connections), you can refer to this document (https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Performance.html#AuroraMySQL.Managing.MaxConnections)
        threshold: 90,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // DatabaseConnectionsSetupFailed
    // The number of database connection requests that failed.
    new cw.Metric({
      namespace: 'AWS/RDS',
      metricName: 'DatabaseConnectionsSetupFailed',
      period: cdk.Duration.minutes(1),
      statistic: cw.Statistic.SUM,
      dimensionsMap: {
        ProxyName: dbProxy.dbProxyName,
      },
    })
      .createAlarm(this, 'DatabaseConnectionsSetupFailedAlarm', {
        evaluationPeriods: 3,
        threshold: 10,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // QueryResponseLatency
    new cw.Metric({
      namespace: 'AWS/RDS',
      metricName: 'QueryResponseLatency',
      period: cdk.Duration.minutes(1),
      statistic: cw.Statistic.AVERAGE,
      dimensionsMap: {
        ProxyName: dbProxy.dbProxyName,
      },
    })
      .createAlarm(this, 'QueryResponseLatencyAlarm', {
        evaluationPeriods: 3,
        threshold: 5000000, // microseconds
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // ----------------------- RDS Event Subscription  -----------------------------
    //   Send critical(see eventCategories) event on all of clusters and instances
    //
    // See: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-eventsubscription.html
    // See: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_Events.html
    //
    // To specify clusters or instances, add "sourceType (sting)" and "sourceIds (list)"
    // sourceType is one of these - db-instance | db-cluster | db-parameter-group | db-security-group | db-snapshot | db-cluster-snapshot
    //
    new rds.CfnEventSubscription(this, 'RdsEventsCluster', {
      snsTopicArn: props.alarmTopic.topicArn,
      enabled: true,
      sourceType: 'db-cluster',
      eventCategories: ['failure', 'failover', 'maintenance'],
    });

    new rds.CfnEventSubscription(this, 'RdsEventsInstances', {
      snsTopicArn: props.alarmTopic.topicArn,
      enabled: true,
      sourceType: 'db-instance',
      eventCategories: [
        'availability',
        'configuration change',
        'deletion',
        'failover',
        'failure',
        'maintenance',
        'notification',
        'recovery',
      ],
    });
  }
}
