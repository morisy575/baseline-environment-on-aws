FROM public.ecr.aws/lambda/nodejs:14

RUN yum install -y wget

# Download the Amazon Root CA 1 trust store from Amazon Trust Services https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html#rds-proxy-security.tls
# Amazon Root CA 1 certificate is necessary for Lambda's IAM authentication and SSL connection (https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-setup.html#rds-proxy-connecting)
RUN wget -O ./AmazonRootCA1.pem https://www.amazontrust.com/repository/AmazonRootCA1.pem 

# Install modules written in requirements.txt
# The file "requirements.txt" now includes 'pg8000' (pure-Python PostgreSQL driver) and 'aws-lambda-powertools' (https://awslabs.github.io/aws-lambda-powertools-python/latest/)
COPY package.json package-lock.json ${LAMBDA_TASK_ROOT}
RUN npm install

COPY ./connection/ ./
CMD ["connection.lambda_handler"]