# Guest RDS Proxy Sample application

## Architecture diagram

![RDSProxySample](../../doc/images/BLEA-GuestRDSProxySample.png)

- bin/blea-guest-rdsproxy-python-sample.ts
  - Lambda + RDS Proxy + Aurora PostgreSQL
  - DB Secrets stored in Secrets Manager
  - Lambda function in Python to confirm that it can connect to RDS instance

## Prerequisite (for this guest sample)

- Docker (https://docs.docker.com/get-docker/)
  - In this guest sample a Docker container image is deployed to Lambda. (https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)

## Notice

### Docker image contents

A command `docker build` runs while `cdk deploy` command is running. The following will be installed or downloaded at this time:

- wget
- Amazon Root CA1 certificate (https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html#rds-proxy-security.tls)
  - Amazon Root CA 1 certificate is necessary for Lambda's IAM authentication and SSL connection.
- DB driver module (`pg8000` for Python, `pg` for Node.js)

### Lambda Runtime

In this guest sample two example Lambda functions are provided, a Python3.9 example and a Node.js14 example. The Lambda checks it can connect to RDS Proxy and Aurora. By default Python example is set to be used, and you can change the runtime by uncommenting the argument in the relevant section (bin/blea-guest-rdsproxy-sample.ts:90).

### Metrics for Monitoring

The metric thresholds defined in this guest sample are for reference only. **The alarm's thresholds you use should be adjusted appropriately, depending on your workload requirements. And also you will add custom metrics for monitoring in some cases.**

### Options for connecting to the RDS Proxy

You have two options for security to connect to RDS Proxy. (https://docs.aws.amazon.com/ja_jp/AmazonRDS/latest/UserGuide/rds-proxy-setup.html#rds-proxy-connecting)

1. **use IAM authentication. This is recommended** because it can remove the need to embed or read credentials in your function code). In this CDK template we use IAM authentication.
2. use your native database credentials stored in Secrets Manager. If you want to implement in this way, you have to create IAM policy that allows Lambda function to access DB credentials in Secrets Manager.

### DB user settings

- In the production environment, you should create DB user account that can use an AWS authentication token and can have only necessary permissions (avoid using DB master user)
  - https://aws.amazon.com/premiumsupport/knowledge-center/users-connect-rds-iam/?nc1=h_ls
